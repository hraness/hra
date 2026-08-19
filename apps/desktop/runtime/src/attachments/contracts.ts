import type {
  ChatMessageAttachmentId,
  ChatMessageId,
  ChatPaneProjection,
} from "../../../contracts/runtime";

export const CHAT_ATTACHMENT_MAX_INPUT_BYTES = 24 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_CHUNK_BYTES = 512 * 1024;
export const CHAT_ATTACHMENT_MAX_PER_MESSAGE = 8;
export const CHAT_ATTACHMENT_MAX_DRAFTS_PER_PANE = 8;
export const CHAT_ATTACHMENT_MAX_REFERENCED_PER_PANE = 32 * 8;
export const CHAT_ATTACHMENT_MAX_PROJECTED_PER_PANE =
  CHAT_ATTACHMENT_MAX_REFERENCED_PER_PANE +
  CHAT_ATTACHMENT_MAX_DRAFTS_PER_PANE;
export const CHAT_ATTACHMENT_MAX_DISPLAY_NAME_UTF8_BYTES = 160;
export const CHAT_ATTACHMENT_MAX_MEDIA_TYPE_BYTES = 127;
export const CHAT_ATTACHMENT_PREVIEW_MAX_BYTES = 512 * 1024;
export const CHAT_ATTACHMENT_DEFAULT_DRAFT_LEASE_MS = 24 * 60 * 60 * 1_000;
export const CHAT_ATTACHMENT_DEFAULT_GC_GRACE_MS = 60 * 60 * 1_000;
export const CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES = 512 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_PANE_READY_BYTES = 128 * 1024 * 1024;

export type ChatAttachmentKind = "image" | "file";
export type ChatAttachmentLifecycleState =
  | "creating"
  | "receiving"
  | "normalizing"
  | "publishing"
  | "ready"
  | "corrupt"
  | "deleting";
export type ChatAttachmentPublicState =
  | "uploading"
  | "processing"
  | "ready"
  | "corrupt";

/** Gateway-private opaque identity; it is never a provider thread identifier. */
export type ChatProviderAttachmentBindingId = string;

export interface ChatAttachmentMetadata {
  readonly id: ChatMessageAttachmentId;
  readonly revision: number;
  readonly kind: ChatAttachmentKind;
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly state: ChatAttachmentPublicState;
  readonly previewAvailable: boolean;
}

export interface ChatAttachmentPaneProjection {
  /** Live composer drafts, in stable creation order. */
  readonly drafts: readonly ChatAttachmentMetadata[];
  /** Metadata for the requested queued or blocked message references. */
  readonly referenced: readonly ChatAttachmentMetadata[];
}

export interface ChatAttachmentMutationResult {
  readonly attachment: ChatAttachmentMetadata;
  readonly changed: boolean;
}

export interface ChatAttachmentRemovalResult {
  readonly attachmentId: ChatMessageAttachmentId;
  readonly removed: true;
  readonly changed: boolean;
}

export interface ChatAttachmentBeginInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly uploadId: string;
  readonly kind: ChatAttachmentKind;
  readonly displayName: string;
  readonly declaredMediaType: string;
  readonly expectedBytes: number;
  readonly now: Date;
  readonly draftLeaseMs?: number;
}

export interface ChatAttachmentAppendInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly uploadId: string;
  readonly expectedRevision: number;
  readonly chunkOrdinal: number;
  readonly base64: string;
  readonly now: Date;
}

export interface ChatAttachmentFinalizeInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly uploadId: string;
  readonly expectedRevision: number;
  readonly inputSha256: string;
  readonly now: Date;
}

export interface ChatAttachmentCancelInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly uploadId: string;
  readonly expectedRevision: number;
  readonly now: Date;
}

export interface ChatAttachmentRemoveInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly expectedRevision: number;
  readonly now: Date;
}

export type ChatAttachmentPreviewRelationship =
  | Readonly<{ kind: "draft" }>
  | Readonly<{ kind: "message"; messageId: ChatMessageId }>;

export interface ChatAttachmentPreviewInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly expectedRevision: number;
  readonly relationship: ChatAttachmentPreviewRelationship;
  readonly now: Date;
}

export interface ChatAttachmentPreview {
  readonly attachmentId: ChatMessageAttachmentId;
  readonly revision: number;
  readonly mediaType: "image/png";
  readonly bytes: Uint8Array;
}

export interface ChatAttachmentProviderLeaseInput {
  readonly bindingId: ChatProviderAttachmentBindingId;
  /** Keyed, content-free digest of the gateway-owned resumable binding. */
  readonly bindingKeyDigest: string;
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentIds: readonly ChatMessageAttachmentId[];
  readonly now: Date;
}

export interface ChatAttachmentProviderLeaseResult {
  readonly bindingId: ChatProviderAttachmentBindingId;
  readonly revision: number;
  readonly state: "active" | "ambiguous" | "released";
  readonly changed: boolean;
}

export interface ChatAttachmentProviderBindingMutationInput {
  readonly bindingId: ChatProviderAttachmentBindingId;
  readonly bindingKeyDigest: string;
  readonly paneId: ChatPaneProjection["id"];
  readonly expectedRevision: number;
  readonly containmentReceipt: string;
  readonly now: Date;
}

export interface ChatAttachmentProviderAmbiguityInput {
  readonly bindingId: ChatProviderAttachmentBindingId;
  readonly bindingKeyDigest: string;
  readonly paneId: ChatPaneProjection["id"];
  readonly expectedRevision: number;
  /** Receipt for the effect cut whose outcome is unknown, not containment. */
  readonly ambiguityReceipt: string;
  readonly now: Date;
}

/**
 * Gateway-private descriptor returned only after an active durable provider
 * lease and a fresh digest/identity verification. `readPath` never crosses the
 * renderer contract.
 */
export interface ChatAttachmentProviderDescriptor {
  readonly attachmentId: ChatMessageAttachmentId;
  readonly kind: ChatAttachmentKind;
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly readPath: string;
}

export interface ChatAttachmentProviderReadInput {
  readonly bindingId: ChatProviderAttachmentBindingId;
  readonly bindingKeyDigest: string;
  readonly paneId: ChatPaneProjection["id"];
  readonly attachmentId: ChatMessageAttachmentId;
  readonly now: Date;
}

export interface ChatAttachmentProjectionInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly referencedAttachmentIds: readonly ChatMessageAttachmentId[];
  readonly now: Date;
}

export interface ChatAttachmentGarbageCollectionInput {
  readonly now: Date;
  readonly graceMs?: number;
  readonly maximumDeletes?: number;
}

export interface ChatAttachmentGarbageCollectionResult {
  readonly deleted: number;
  readonly contained: number;
}

export interface ChatAttachmentPrivacyDeletionInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly now: Date;
  readonly authorizationReceipt: string;
  /** Independent proof that no provider binding for the pane can resume. */
  readonly containmentReceipt: string;
}

export interface ChatAttachmentPaneArchiveInput {
  readonly paneId: ChatPaneProjection["id"];
  readonly now: Date;
  /** Proof that no provider binding owned by this pane can resume. */
  readonly containmentReceipt: string;
}

export interface ChatAttachmentReconciliationResult {
  readonly resumedChunks: number;
  readonly rolledBackChunks: number;
  readonly normalized: number;
  readonly published: number;
  readonly contained: number;
  readonly deleted: number;
  readonly residueRemoved: number;
}

/** Frozen gateway-private attachment vault seam. */
export interface ChatAttachmentVault {
  reconcile(now: Date): Promise<ChatAttachmentReconciliationResult>;
  beginUpload(input: ChatAttachmentBeginInput): Promise<ChatAttachmentMutationResult>;
  appendChunk(input: ChatAttachmentAppendInput): Promise<ChatAttachmentMutationResult>;
  finalizeUpload(input: ChatAttachmentFinalizeInput): Promise<ChatAttachmentMutationResult>;
  cancelUpload(input: ChatAttachmentCancelInput): Promise<ChatAttachmentRemovalResult>;
  removeAttachment(input: ChatAttachmentRemoveInput): Promise<ChatAttachmentRemovalResult>;
  projectPane(input: ChatAttachmentProjectionInput): ChatAttachmentPaneProjection;
  readPreview(input: ChatAttachmentPreviewInput): Promise<ChatAttachmentPreview>;
  acquireProviderLease(
    input: ChatAttachmentProviderLeaseInput,
  ): ChatAttachmentProviderLeaseResult;
  readProviderBinding(input: Readonly<{
    readonly bindingId: ChatProviderAttachmentBindingId;
    readonly bindingKeyDigest: string;
    readonly paneId: ChatPaneProjection["id"];
  }>): ChatAttachmentProviderLeaseResult | null;
  paneHasRetainedProviderBindings(paneId: ChatPaneProjection["id"]): boolean;
  markProviderBindingAmbiguous(
    input: ChatAttachmentProviderAmbiguityInput,
  ): ChatAttachmentProviderLeaseResult;
  releaseProviderBindingAfterResumeContained(
    input: ChatAttachmentProviderBindingMutationInput,
  ): ChatAttachmentProviderLeaseResult;
  /** Caller-owned SQLite transaction variant for atomic account detachment. */
  releaseProviderBindingAfterResumeContainedInTransaction(
    input: ChatAttachmentProviderBindingMutationInput,
  ): ChatAttachmentProviderLeaseResult;
  providerDescriptor(
    input: ChatAttachmentProviderReadInput,
  ): Promise<ChatAttachmentProviderDescriptor>;
  collectGarbage(
    input: ChatAttachmentGarbageCollectionInput,
  ): Promise<ChatAttachmentGarbageCollectionResult>;
  /** Read-only compatibility check required before any provider archive effect. */
  assertPaneArchiveCompatible(paneId: ChatPaneProjection["id"]): void;
  /**
   * Stricter v57 admission cut. It rejects every attachment writer or
   * deletion state whose asynchronous filesystem work could cross the
   * durable provider-archive target/cut boundary.
   */
  assertProviderThreadArchiveV57Compatible(
    paneId: ChatPaneProjection["id"],
  ): void;
  /**
   * Caller-transaction-composable terminal Vault postimage check. Startup may
   * invoke this only with the exact committed target snapshot previously
   * authorized after Store verification.
   */
  assertProviderThreadArchiveTerminalPostimagesV57(
    expectedCommittedTargetIds: readonly string[],
  ): void;
  /** First half of the caller-owned SQLite pane-archive transaction. */
  preparePaneArchiveInTransaction(input: ChatAttachmentPaneArchiveInput): void;
  /** Second half, called only after `chat_panes.archived_at` was advanced. */
  markPaneArchivedInTransaction(input: ChatAttachmentPaneArchiveInput): void;
  archivePaneAfterResumeContained(input: ChatAttachmentPaneArchiveInput): Promise<void>;
  deletePanePrivateData(input: ChatAttachmentPrivacyDeletionInput): Promise<void>;
}

export type ChatAttachmentVaultErrorCode =
  | "conflict"
  | "corrupt"
  | "invalid_input"
  | "invalid_state"
  | "not_found"
  | "quota_exceeded"
  | "revision_conflict"
  | "unsafe_filesystem";

export class ChatAttachmentVaultError extends Error {
  readonly code: ChatAttachmentVaultErrorCode;

  constructor(code: ChatAttachmentVaultErrorCode, message: string) {
    super(message);
    this.name = "ChatAttachmentVaultError";
    this.code = code;
  }
}
