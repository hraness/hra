import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  runtimeChatAttachmentChunkByteLimit,
  runtimeChatAttachmentDraftLimit,
  runtimeChatAttachmentInputByteLimit,
  type ChatAttachmentMetadata,
  type ChatMessageAttachmentId,
} from "../../../../contracts/runtime";
import type { RuntimeShell } from "../../runtime";
import type {
  CompactAttachmentPreview,
  CompactChatPaneSurface,
} from "./CompactChatSurface";

export interface ActiveUpload {
  readonly uploadId: string;
  revision: number;
}

export function synchronizeActiveUploadRevision(
  activeUpload: ActiveUpload | undefined,
  projectedRevision: number,
): void {
  if (activeUpload !== undefined && projectedRevision > activeUpload.revision) {
    activeUpload.revision = projectedRevision;
  }
}

export function availableAttachmentUploadSlots(
  draftCount: number,
  locallyAdmitted: number,
): number {
  return Math.max(0, runtimeChatAttachmentDraftLimit - draftCount - locallyAdmitted);
}

export class AttachmentUploadAdmissionQueue {
  #locallyAdmitted = 0;
  #tail: Promise<void> = Promise.resolve();

  get locallyAdmitted(): number {
    return this.#locallyAdmitted;
  }

  enqueue<T>(input: Readonly<{
    draftCount: number;
    items: readonly T[];
    run: (item: T) => Promise<"awaitingProjection" | "released" | void>;
  }>): Readonly<{
    acceptedCount: number;
    rejectedCount: number;
    settled: Promise<void>;
  }> {
    const available = availableAttachmentUploadSlots(
      input.draftCount,
      this.#locallyAdmitted,
    );
    const accepted = input.items.slice(0, available);
    this.#locallyAdmitted += accepted.length;
    const settled = this.#tail.then(async () => {
      let firstFailure: unknown = null;
      for (const item of accepted) {
        try {
          const outcome = await input.run(item);
          if (outcome !== "awaitingProjection") this.#locallyAdmitted -= 1;
        } catch (reason: unknown) {
          firstFailure ??= reason;
          this.#locallyAdmitted -= 1;
        }
      }
      if (firstFailure instanceof Error) throw firstFailure;
      if (firstFailure !== null) {
        throw new Error("The attachment upload failed.", { cause: firstFailure });
      }
    });
    this.#tail = settled.catch(() => undefined);
    return {
      acceptedCount: accepted.length,
      rejectedCount: input.items.length - accepted.length,
      settled,
    };
  }

  acknowledgeProjected(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1 || count > this.#locallyAdmitted) {
      throw new Error("Projected attachment acknowledgement exceeds local admission.");
    }
    this.#locallyAdmitted -= count;
  }
}

export function finalizedAttachmentProjectionOutcome(input: Readonly<{
  attachmentId: ChatMessageAttachmentId;
  projectedIds: ReadonlySet<ChatMessageAttachmentId>;
  observedIds: Set<ChatMessageAttachmentId>;
  consumedIds: ReadonlySet<ChatMessageAttachmentId>;
  awaitingIds: Set<ChatMessageAttachmentId>;
}>): "awaitingProjection" | "released" {
  const wasObserved = input.observedIds.delete(input.attachmentId);
  if (
    input.projectedIds.has(input.attachmentId) ||
    wasObserved ||
    input.consumedIds.has(input.attachmentId)
  ) return "released";
  input.awaitingIds.add(input.attachmentId);
  return "awaitingProjection";
}

export function rememberObservedAttachmentProjections(input: Readonly<{
  projectedIds: ReadonlySet<ChatMessageAttachmentId>;
  trackedIds: ReadonlySet<ChatMessageAttachmentId>;
  observedIds: Set<ChatMessageAttachmentId>;
}>): void {
  for (const attachmentId of input.projectedIds) {
    if (input.trackedIds.has(attachmentId)) input.observedIds.add(attachmentId);
  }
}

export function acknowledgeAwaitingAttachmentProjections(input: Readonly<{
  projectedIds: ReadonlySet<ChatMessageAttachmentId>;
  awaitingIds: Set<ChatMessageAttachmentId>;
  observedIds?: Set<ChatMessageAttachmentId>;
}>): number {
  let acknowledged = 0;
  for (const attachmentId of input.awaitingIds) {
    if (!input.projectedIds.has(attachmentId)) continue;
    input.awaitingIds.delete(attachmentId);
    input.observedIds?.delete(attachmentId);
    acknowledged += 1;
  }
  return acknowledged;
}

export function acknowledgeConsumedAttachmentProjections(input: Readonly<{
  consumedIds: readonly ChatMessageAttachmentId[];
  awaitingIds: Set<ChatMessageAttachmentId>;
  observedIds: Set<ChatMessageAttachmentId>;
}>): number {
  let acknowledged = 0;
  for (const attachmentId of input.consumedIds) {
    input.observedIds.delete(attachmentId);
    if (!input.awaitingIds.delete(attachmentId)) continue;
    acknowledged += 1;
  }
  return acknowledged;
}

export function attachmentRemovalCommand(input: Readonly<{
  paneId: string;
  attachment: ChatAttachmentMetadata;
  activeUpload: ActiveUpload | undefined;
}>) {
  return input.activeUpload === undefined
    ? {
        type: "chat.attachment.remove" as const,
        paneId: input.paneId,
        attachmentId: input.attachment.id,
        expectedRevision: input.attachment.revision,
      }
    : {
        type: "chat.attachment.cancel" as const,
        paneId: input.paneId,
        attachmentId: input.attachment.id,
        uploadId: input.activeUpload.uploadId,
        expectedRevision: input.activeUpload.revision,
      };
}

export interface AttachmentUploadPort {
  readonly dispatch: RuntimeShell["dispatch"];
}

export interface AttachmentUploadIdentity {
  readonly attachmentId: ChatMessageAttachmentId;
  readonly uploadId: string;
}

function opaqueId(prefix: "attachment" | "upload"): string {
  const random = globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${random}`;
}

export function createAttachmentUploadIdentity(): AttachmentUploadIdentity {
  return {
    attachmentId: opaqueId("attachment"),
    uploadId: opaqueId("upload"),
  };
}

export function canonicalBase64Chunk(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(
      offset,
      Math.min(bytes.byteLength, offset + 16_384),
    ));
  }
  return btoa(binary);
}

export function validateAttachmentInputBytes(bytes: number): number {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > runtimeChatAttachmentInputByteLimit
  ) {
    throw new Error("Attachments must be between 1 byte and 24 MiB.");
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes).buffer;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function attachmentFromResponse(
  response: Awaited<ReturnType<RuntimeShell["dispatch"]>>,
  identity: AttachmentUploadIdentity,
): ChatAttachmentMetadata {
  if (!response.ok) throw new Error(response.error.message);
  if (
    response.result.type !== "chatAttachment" ||
    response.result.attachment.id !== identity.attachmentId ||
    response.result.uploadId !== identity.uploadId
  ) {
    throw new Error("The local runtime returned the wrong attachment result.");
  }
  return response.result.attachment;
}

export async function uploadAttachmentFile(input: Readonly<{
  port: AttachmentUploadPort;
  paneId: string;
  file: File;
  identity?: AttachmentUploadIdentity;
  onRevision?: (revision: number) => void;
}>): Promise<ChatAttachmentMetadata> {
  validateAttachmentInputBytes(input.file.size);
  const declaredMediaType = input.file.type.trim();
  if (!declaredMediaType.startsWith("image/")) {
    throw new Error("HRA currently supports image attachments only.");
  }
  const identity = input.identity ?? createAttachmentUploadIdentity();
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  if (bytes.byteLength !== input.file.size) {
    throw new Error("The selected attachment changed while it was being read.");
  }
  const inputSha256 = await sha256Hex(bytes);
  let attachment = attachmentFromResponse(await input.port.dispatch({
    type: "chat.attachment.begin",
    paneId: input.paneId,
    attachmentId: identity.attachmentId,
    uploadId: identity.uploadId,
    kind: "image",
    displayName: input.file.name.trim() || "attachment",
    declaredMediaType,
    expectedBytes: bytes.byteLength,
  }), identity);
  input.onRevision?.(attachment.revision);

  let chunkOrdinal = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += runtimeChatAttachmentChunkByteLimit) {
    const chunk = bytes.subarray(
      offset,
      Math.min(bytes.byteLength, offset + runtimeChatAttachmentChunkByteLimit),
    );
    attachment = attachmentFromResponse(await input.port.dispatch({
      type: "chat.attachment.append",
      paneId: input.paneId,
      attachmentId: identity.attachmentId,
      uploadId: identity.uploadId,
      expectedRevision: attachment.revision,
      chunkOrdinal,
      base64: canonicalBase64Chunk(chunk),
    }), identity);
    input.onRevision?.(attachment.revision);
    chunkOrdinal += 1;
  }

  attachment = attachmentFromResponse(await input.port.dispatch({
    type: "chat.attachment.finalize",
    paneId: input.paneId,
    attachmentId: identity.attachmentId,
    uploadId: identity.uploadId,
    expectedRevision: attachment.revision,
    inputSha256,
  }), identity);
  input.onRevision?.(attachment.revision);
  return attachment;
}

function decodeCanonicalBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (canonicalBase64Chunk(bytes) !== base64) {
    throw new Error("The attachment preview was not canonical base64.");
  }
  return bytes;
}

export interface AttachmentPreviewUrlEnvironment {
  readonly create: (blob: Blob) => string;
  readonly revoke: (url: string) => void;
}

export class AttachmentPreviewObjectUrls {
  readonly #environment: AttachmentPreviewUrlEnvironment;
  readonly #urls = new Map<string, string>();

  constructor(environment: AttachmentPreviewUrlEnvironment) {
    this.#environment = environment;
  }

  url(key: string): string | null {
    return this.#urls.get(key) ?? null;
  }

  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.#urls);
  }

  reconcile(liveKeys: ReadonlySet<string>): void {
    for (const [key, url] of this.#urls) {
      if (liveKeys.has(key)) continue;
      this.#environment.revoke(url);
      this.#urls.delete(key);
    }
  }

  install(input: Readonly<{
    key: string;
    mediaType: string;
    base64: string;
  }>): string {
    const existing = this.#urls.get(input.key);
    if (existing !== undefined) return existing;
    if (input.mediaType !== "image/png") {
      throw new Error("Attachment previews must be normalized image/png.");
    }
    const bytes = Uint8Array.from(decodeCanonicalBase64(input.base64)).buffer;
    const url = this.#environment.create(new Blob([bytes], { type: "image/png" }));
    if (!url.startsWith("blob:")) {
      this.#environment.revoke(url);
      throw new Error("Attachment previews require an owned blob URL.");
    }
    this.#urls.set(input.key, url);
    return url;
  }

  removeAttachment(attachmentId: ChatMessageAttachmentId): void {
    for (const [key, url] of this.#urls) {
      if (!key.startsWith(`${attachmentId}:`)) continue;
      this.#environment.revoke(url);
      this.#urls.delete(key);
    }
  }

  dispose(): void {
    for (const url of this.#urls.values()) this.#environment.revoke(url);
    this.#urls.clear();
  }
}

function previewStatus(
  state: ChatAttachmentMetadata["state"],
): CompactAttachmentPreview["status"] {
  if (state === "ready") return "ready";
  if (state === "corrupt") return "failed";
  return "processing";
}

export function useLiveChatAttachments(input: Readonly<{
  enabled: boolean;
  pane: { readonly id: string; readonly attachments: {
    readonly drafts: readonly ChatAttachmentMetadata[];
  } } | null;
  shell: RuntimeShell;
}>): CompactChatPaneSurface | undefined {
  const { enabled, pane, shell } = input;
  const [previewUrls, setPreviewUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const previewStoreRef = useRef<AttachmentPreviewObjectUrls | null>(null);
  const uploadsRef = useRef(new Map<ChatMessageAttachmentId, ActiveUpload>());
  const uploadQueueRef = useRef(new AttachmentUploadAdmissionQueue());
  const awaitingProjectionRef = useRef(new Set<ChatMessageAttachmentId>());
  const observedProjectionRef = useRef(new Set<ChatMessageAttachmentId>());
  const projectedDraftIdsRef = useRef<ReadonlySet<ChatMessageAttachmentId>>(
    new Set(),
  );
  const enqueuedRef = useRef(new Set<ChatMessageAttachmentId>());

  const drafts = enabled && pane !== null ? pane.attachments.drafts : [];
  const draftIdentity = drafts.map(({ id, revision }) => `${id}:${revision}`).join("\0");

  useEffect(() => {
    if (!enabled || pane === null) return;
    const previewStore = previewStoreRef.current ?? new AttachmentPreviewObjectUrls({
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => URL.revokeObjectURL(url),
    });
    previewStoreRef.current = previewStore;
    const liveKeys = new Set(drafts.map(({ id, revision }) => `${id}:${revision}`));
    const projectedDraftIds = new Set(drafts.map(({ id }) => id));
    projectedDraftIdsRef.current = projectedDraftIds;
    rememberObservedAttachmentProjections({
      projectedIds: projectedDraftIds,
      trackedIds: new Set([
        ...uploadsRef.current.keys(),
        ...awaitingProjectionRef.current,
      ]),
      observedIds: observedProjectionRef.current,
    });
    previewStore.reconcile(liveKeys);
    for (const attachment of drafts) {
      synchronizeActiveUploadRevision(
        uploadsRef.current.get(attachment.id),
        attachment.revision,
      );
    }
    for (const attachmentId of enqueuedRef.current) {
      if (!drafts.some(({ id }) => id === attachmentId)) {
        enqueuedRef.current.delete(attachmentId);
      }
    }
    const acknowledged = acknowledgeAwaitingAttachmentProjections({
      projectedIds: projectedDraftIds,
      awaitingIds: awaitingProjectionRef.current,
      observedIds: observedProjectionRef.current,
    });
    if (acknowledged > 0) {
      uploadQueueRef.current.acknowledgeProjected(acknowledged);
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      for (const attachment of drafts) {
        if (
          attachment.state !== "ready" ||
          attachment.kind !== "image" ||
          !attachment.previewAvailable ||
          enqueuedRef.current.has(attachment.id)
        ) continue;
        const key = `${attachment.id}:${attachment.revision}`;
        if (previewStore.url(key) !== null) continue;
        const response = await shell.dispatch({
          type: "chat.attachment.preview",
          paneId: pane.id,
          attachmentId: attachment.id,
          expectedRevision: attachment.revision,
          relationship: { kind: "draft" },
        });
        if (cancelled) return;
        if (!response.ok) throw new Error(response.error.message);
        if (
          response.result.type !== "chatAttachmentPreview" ||
          response.result.attachmentId !== attachment.id ||
          response.result.revision !== attachment.revision ||
          response.result.mediaType !== "image/png"
        ) {
          throw new Error("The local runtime returned the wrong attachment preview.");
        }
        previewStore.install({
          key,
          mediaType: response.result.mediaType,
          base64: response.result.base64,
        });
        if (cancelled) return;
        setPreviewUrls(previewStore.snapshot());
      }
      setPreviewUrls(previewStore.snapshot());
      setError(null);
    };
    void load().catch((reason: unknown) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : "Attachment preview failed.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draftIdentity, drafts, enabled, pane, shell]);

  useEffect(() => () => {
    previewStoreRef.current?.dispose();
    previewStoreRef.current = null;
  }, []);

  const onAttachFiles = useCallback((files: readonly File[]) => {
    if (!enabled || pane === null) return;
    setError(null);
    if (files.some((file) => !file.type.trim().startsWith("image/"))) {
      setError("HRA currently supports image attachments only.");
      return;
    }
    const admission = uploadQueueRef.current.enqueue({
      draftCount: drafts.length,
      items: files,
      run: async (file) => {
        const identity = createAttachmentUploadIdentity();
        uploadsRef.current.set(identity.attachmentId, {
          uploadId: identity.uploadId,
          revision: 1,
        });
        await uploadAttachmentFile({
          port: shell,
          paneId: pane.id,
          file,
          identity,
          onRevision: (revision) => {
            const upload = uploadsRef.current.get(identity.attachmentId);
            if (upload !== undefined) upload.revision = revision;
          },
        });
        uploadsRef.current.delete(identity.attachmentId);
        return finalizedAttachmentProjectionOutcome({
          attachmentId: identity.attachmentId,
          projectedIds: projectedDraftIdsRef.current,
          observedIds: observedProjectionRef.current,
          consumedIds: enqueuedRef.current,
          awaitingIds: awaitingProjectionRef.current,
        });
      },
    });
    if (admission.rejectedCount > 0) {
      setError("A pane can hold at most 8 attachment drafts.");
    }
    void admission.settled.then(() => setError(null)).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Attachment upload failed.");
    });
  }, [drafts.length, enabled, pane, shell]);

  const onRemoveAttachment = useCallback((attachmentId: ChatMessageAttachmentId) => {
    if (!enabled || pane === null) return;
    const attachment = drafts.find(({ id }) => id === attachmentId);
    if (attachment === undefined) return;
    setError(null);
    void (async () => {
      const active = uploadsRef.current.get(attachmentId);
      const command = attachmentRemovalCommand({
        paneId: pane.id,
        attachment,
        activeUpload: active,
      });
      const response = await shell.dispatch(command);
      if (!response.ok) throw new Error(response.error.message);
      if (
        response.result.type !== "chatAttachmentRemoved" ||
        response.result.attachmentId !== attachmentId
      ) {
        throw new Error("The local runtime returned the wrong attachment removal result.");
      }
      uploadsRef.current.delete(attachmentId);
      previewStoreRef.current?.removeAttachment(attachmentId);
      setPreviewUrls(previewStoreRef.current?.snapshot() ?? new Map());
      setError(null);
    })().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Attachment removal failed.");
    });
  }, [drafts, enabled, pane, shell]);

  const onAttachmentsEnqueued = useCallback((attachmentIds: readonly ChatMessageAttachmentId[]) => {
    const acknowledged = acknowledgeConsumedAttachmentProjections({
      consumedIds: attachmentIds,
      awaitingIds: awaitingProjectionRef.current,
      observedIds: observedProjectionRef.current,
    });
    if (acknowledged > 0) {
      uploadQueueRef.current.acknowledgeProjected(acknowledged);
    }
    for (const attachmentId of attachmentIds) {
      enqueuedRef.current.add(attachmentId);
      previewStoreRef.current?.removeAttachment(attachmentId);
    }
    setPreviewUrls(previewStoreRef.current?.snapshot() ?? new Map());
  }, []);

  const attachments = useMemo<readonly CompactAttachmentPreview[]>(() => drafts
    .filter(({ id }) => !enqueuedRef.current.has(id))
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.displayName,
      mimeType: attachment.mediaType,
      byteSize: attachment.bytes,
      status: previewStatus(attachment.state),
      previewUrl: previewUrls.get(`${attachment.id}:${attachment.revision}`) ?? null,
    })), [draftIdentity, drafts, previewUrls]);

  if (!enabled || pane === null) return undefined;
  return {
    attachments,
    attachmentError: error,
    onAttachFiles,
    onAttachmentsEnqueued,
    onRemoveAttachment,
  };
}
