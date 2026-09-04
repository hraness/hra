/**
 * The one seam between the browser app and the repository source.
 *
 * Only `src/cloud/{crypto,projection,payloads,contracts,client}` and
 * `src/domain/*` are browser safe. Every other `src/cloud` module reaches for
 * node built-ins, the local daemon, or on-disk secret custody and must never
 * enter this bundle. Keeping the deep relative paths in one file makes the
 * boundary reviewable and keeps the eslint layering rule enforceable.
 */
export {
  canonicalDevicePublicKeyJson,
  decodeBase64Url,
  deviceBindMessage,
  encodeBase64Url,
  encryptBytes,
  exportDevicePublicKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  hmacSha256Hex,
  parseDevicePublicKeyJson,
  randomKeyBytes,
  sha256Hex,
  signDeviceBind,
  unwrapAccountDataKey,
  type DevicePublicKey,
} from "../../../src/cloud/crypto";

export {
  cloudLimits,
  hasExactKeys,
  isBase64Url,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
  parseWrappedKeyEnvelope,
  type AuthorityTuple,
  type CommandKind,
  type CommandState,
  type EncryptedEnvelope,
  type SyncStream,
  type WrappedKeyEnvelope,
} from "../../../src/cloud/contracts";

export {
  decryptCompactEvents,
  decryptDetailEvents,
  parseCompactSessionEvent,
  parseDetailSessionEvent,
  sessionChunkAad,
  type CompactInteractionKind,
  type CompactInteractionState,
  type CompactSessionEvent,
  type DetailSessionEvent,
  type ModelPreset,
  type SessionChunkAuthority,
  type SessionStateValue,
} from "../../../src/cloud/projection";

export {
  cloudPayloadAad,
  decryptSessionMetadata,
  encryptRemoteCommand,
  type CloudPayloadAuthority,
  type RemoteCommandPayload,
  type SessionMetadataPayload,
} from "../../../src/cloud/payloads";

export type {
  CloudAction,
  CloudMutation,
  CloudQuery,
} from "../../../src/cloud/client";

export {
  createCloudUuidV7,
} from "../../../src/domain/uuid-v7";
