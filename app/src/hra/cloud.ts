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
  decryptBytes,
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
  COMMAND_KINDS,
  containsAbsolutePath,
  containsSecretShapedText,
  containsUnsafeTerminalScalar,
  DEVICE_COMMAND_KINDS,
  hasExactKeys,
  isBase64Url,
  isCommandKind,
  isDeviceCommandKind,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
  parseWrappedKeyEnvelope,
  snapshotForeignJson,
  type AuthorityTuple,
  type CommandKind,
  type CommandState,
  type DeviceCommandKind,
  type EncryptedEnvelope,
  type SyncStream,
  type WrappedKeyEnvelope,
} from "../../../src/cloud/contracts";

export {
  compactInteractionDetailLimits,
  decryptCompactEvents,
  decryptDetailEvents,
  parseCompactSessionEvent,
  parseDetailSessionEvent,
  remoteInteractionPolicyReasonCodeOrder,
  sessionChunkAad,
  type CompactInteractionDecision,
  type CompactInteractionKind,
  type CompactInteractionQuestion,
  type CompactInteractionState,
  type CompactRemoteInteractionAction,
  type CompactRemoteInteractionPolicy,
  type CompactRemoteInteractionQuestion,
  type CompactRemoteInteractionReasonCode,
  type CompactMessageActor,
  type CompactSessionEvent,
  type DetailSessionEvent,
  type GitAction,
  type ModelPreset,
  type SessionChunkAuthority,
  type SessionStateValue,
} from "../../../src/cloud/projection";

export {
  cloudPayloadAad,
  decryptDeviceCommandResult,
  decryptDeviceRegistry,
  decryptNotificationEmail,
  decryptNotificationHours,
  decryptSessionMetadata,
  deviceCommandLoginResultLifetimeMs,
  deviceCommandLimits,
  deviceRegistryLimits,
  encryptDeviceCommand,
  encryptRemoteCommand,
  encryptNotificationHours,
  parseDeviceCommandPayload,
  parseDeviceCommandResultPayload,
  parseDeviceRegistryPayload,
  parseRemoteCommandPayload,
  remoteInteractionAnswersFitCommandEnvelope,
  type CloudPayloadAuthority,
  type DeviceCommandPayload,
  type DeviceCommandResultPayload,
  type DeviceRegistryAccount,
  type DeviceRegistryPayload,
  type DeviceRegistryProject,
  type DeviceRegistryScheduledTask,
  type RemoteCommandPayload,
  type SessionMetadataPayload,
} from "../../../src/cloud/payloads";

export type {
  NotificationEmailPolicy,
} from "../../../src/domain/notification-email-contract";

export type {
  NotificationHoursPolicy,
  NotificationHoursUpdate,
} from "../../../src/domain/notification-hours";

export type {
  CloudAction,
  CloudMutation,
  CloudQuery,
} from "../../../src/cloud/client";

export {
  createCloudUuidV7,
} from "../../../src/domain/uuid-v7";

export {
  remoteInteractionAnswerLimits,
  remoteInteractionJsonFitsProviderLimit,
} from "../../../src/domain/remote-interaction-contract";
