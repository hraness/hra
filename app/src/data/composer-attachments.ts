/**
 * The composer's attachment state.
 *
 * Every rule this hook applies lives in `model/attachments.ts`; what is here is
 * the browser plumbing: reading a `File`, decoding it through the canvas
 * wrapper, minting a preview handle, and revoking it again.
 *
 * A paste needs no permission. `clipboard-read` is denied in the app's
 * Permissions-Policy and stays denied: that gates the asynchronous Clipboard
 * API, which reads the clipboard without the reader doing anything.
 * `event.clipboardData.files` is the other thing entirely, the payload of a
 * paste the reader just performed, and it is available to the handler for that
 * event.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";

import { measureImage } from "../lib/canvas-image";
import {
  attachmentKind,
  inlineBudgetRefusal,
  normaliseMediaType,
  prepareAttachment,
  selectAttachments,
  type PreparedAttachment,
} from "../model/attachments";

export type ComposerAttachment = PreparedAttachment & Readonly<{
  /** A blob URL for the thumbnail, or null for a text-ish attachment. */
  previewUrl: string | null;
}>;

export type ComposerAttachments = Readonly<{
  addFiles: (files: readonly File[]) => void;
  attachments: readonly ComposerAttachment[];
  /** True while a paste is being decoded and downscaled. */
  busy: boolean;
  clear: () => void;
  dragging: boolean;
  notice: string | null;
  onDragLeave: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
  onPaste: (event: ReactClipboardEvent) => void;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  remove: (id: string) => void;
  /** The one line that blocks the send, or null. */
  sendRefusal: string | null;
}>;

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `attachment-${String(sequence)}`;
}

function revoke(attachment: ComposerAttachment): void {
  if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
}

export function useComposerAttachments(): ComposerAttachments {
  const [attachments, setAttachmentsState] = useState<readonly ComposerAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<readonly ComposerAttachment[]>([]);

  const setAttachments = useCallback((next: readonly ComposerAttachment[]) => {
    listRef.current = next;
    setAttachmentsState(next);
  }, []);

  // The tab keeps blob handles for the thumbnails; unmounting the composer
  // gives them back rather than leaking one per pasted screenshot.
  useEffect(() => () => {
    for (const attachment of listRef.current) revoke(attachment);
    listRef.current = [];
  }, []);

  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setNotice(null);
    void (async () => {
      const current = listRef.current;
      const selection = selectAttachments(
        files,
        (file) => ({ mediaType: file.type, name: file.name, size: file.size }),
        {
          count: current.length,
          totalBytes: current.reduce((sum, item) => sum + item.sourceBytes, 0),
        },
      );
      const prepared: ComposerAttachment[] = [];
      for (const file of selection.accepted) {
        const mediaType = normaliseMediaType(file.type);
        if (mediaType === null) continue;
        const isImage = attachmentKind(mediaType) === "image";
        const item = await prepareAttachment({
          bytes: new Uint8Array(await file.arrayBuffer()),
          id: nextId(),
          measure: isImage ? () => measureImage(file) : null,
          mediaType,
          name: file.name,
        });
        prepared.push({
          ...item,
          previewUrl: item.kind === "image"
            ? URL.createObjectURL(new Blob([new Uint8Array(item.bytes)], { type: item.mediaType }))
            : null,
        });
      }
      setAttachments([...listRef.current, ...prepared]);
      setNotice(selection.refusals.length === 0 ? null : selection.refusals.join(" "));
      setBusy(false);
    })();
  }, [setAttachments]);

  const remove = useCallback((id: string) => {
    const kept: ComposerAttachment[] = [];
    for (const attachment of listRef.current) {
      if (attachment.id === id) revoke(attachment);
      else kept.push(attachment);
    }
    setAttachments(kept);
  }, [setAttachments]);

  const clear = useCallback(() => {
    for (const attachment of listRef.current) revoke(attachment);
    setAttachments([]);
    setNotice(null);
  }, [setAttachments]);

  const onPaste = useCallback((event: ReactClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    // Only a paste that actually carries files is intercepted; a text paste
    // still lands in the textarea.
    event.preventDefault();
    addFiles(files);
  }, [addFiles]);

  const onDrop = useCallback((event: ReactDragEvent) => {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }, [addFiles]);

  const onDragOver = useCallback((event: ReactDragEvent) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => { setDragging(false); }, []);

  const onPick = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files;
    if (picked !== null) addFiles([...picked]);
    // Reset, so picking the same file twice in a row still fires a change.
    event.target.value = "";
  }, [addFiles]);

  const firstRefusal = attachments.find((item) => item.refusal !== null)?.refusal ?? null;

  return {
    addFiles,
    attachments,
    busy,
    clear,
    dragging,
    notice,
    onDragLeave,
    onDragOver,
    onDrop,
    onPaste,
    onPick,
    remove,
    sendRefusal: firstRefusal ?? inlineBudgetRefusal(attachments),
  };
}
