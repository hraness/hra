import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChatPane } from "../src/features/chat/ChatPane";
import type {
  CompactAttachmentPreview,
  CompactChatPaneSurface,
} from "../src/features/chat/CompactChatSurface";
import { isRasterImagePreviewMimeType } from "../src/features/chat/CompactChatSurface";
import type { RuntimeShell } from "../src/runtime";
import { useUiScale } from "../src/ui-scale";
import type { HRADirectWorld } from "./world";

type CompactSurfaceWorld = Extract<HRADirectWorld["surface"], { kind: "compactChat" }>;

const previewPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAWyb0asAAAAASUVORK5CYII=";

function previewPng(): Blob {
  const binary = globalThis.atob(previewPngBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes.buffer], { type: "image/png" });
}

export function DirectCompactChatSurface({
  onRuntimeShell,
  shellFactory,
  world,
}: Readonly<{
  onRuntimeShell?: (shell: RuntimeShell) => void;
  shellFactory: () => RuntimeShell;
  world: CompactSurfaceWorld;
}>) {
  useUiScale();
  const [shell, setShell] = useState<RuntimeShell | null>(null);
  const [attachments, setAttachments] = useState<readonly CompactAttachmentPreview[]>([]);
  const attachmentOrdinal = useRef(world.attachments.length + 1);
  const previewUrls = useRef(new Set<string>());
  const createPreviewUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    previewUrls.current.add(url);
    return url;
  }, []);
  const revokePreviewUrl = useCallback((url: string): void => {
    URL.revokeObjectURL(url);
    previewUrls.current.delete(url);
  }, []);

  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);

  useEffect(() => {
    const nextShell = shellFactory();
    setShell(nextShell);
    onRuntimeShell?.(nextShell);
    void nextShell.connect();
    return () => {
      setShell((current) => current === nextShell ? null : current);
      nextShell.dispose();
    };
  }, [onRuntimeShell, shellFactory]);

  useEffect(() => {
    const seeded = world.attachments.map((attachment) => ({
      ...attachment,
      previewUrl: createPreviewUrl(previewPng()),
      status: "ready" as const,
    }));
    setAttachments(seeded);
    return () => {
      for (const attachment of seeded) {
        if (attachment.previewUrl !== null) revokePreviewUrl(attachment.previewUrl);
      }
    };
  }, [createPreviewUrl, revokePreviewUrl, world.attachments]);

  const removeAttachment = useCallback((attachmentId: CompactAttachmentPreview["id"]) => {
    setAttachments((current) => {
      const removed = current.find(({ id }) => id === attachmentId);
      if (removed?.previewUrl !== null && removed?.previewUrl !== undefined) {
        revokePreviewUrl(removed.previewUrl);
      }
      return current.filter(({ id }) => id !== attachmentId);
    });
  }, [revokePreviewUrl]);

  const attachFiles = useCallback((files: readonly File[]) => {
    setAttachments((current) => [
      ...current,
      ...files.slice(0, Math.max(0, 8 - current.length)).map((file) => {
        const ordinal = attachmentOrdinal.current;
        attachmentOrdinal.current += 1;
        return {
          id: `attachment_direct${String(ordinal).padStart(8, "0")}`,
          name: file.name || `pasted-image-${ordinal}.png`,
          mimeType: file.type || "application/octet-stream",
          byteSize: file.size,
          previewUrl: isRasterImagePreviewMimeType(file.type)
            ? createPreviewUrl(file)
            : null,
          status: "ready" as const,
        };
      }),
    ]);
  }, [createPreviewUrl]);

  const consumeAttachments = useCallback((attachmentIds: readonly CompactAttachmentPreview["id"][]) => {
    const consumed = new Set(attachmentIds);
    setAttachments((current) => {
      for (const attachment of current) {
        if (consumed.has(attachment.id) && attachment.previewUrl !== null) {
          revokePreviewUrl(attachment.previewUrl);
        }
      }
      return current.filter(({ id }) => !consumed.has(id));
    });
  }, [revokePreviewUrl]);

  const surface = useMemo<CompactChatPaneSurface>(() => ({
    attachments,
    nowUnixMilliseconds: world.nowUnixMilliseconds,
    onAttachFiles: attachFiles,
    onAttachmentsEnqueued: consumeAttachments,
    onRemoveAttachment: removeAttachment,
  }), [
    attachFiles,
    attachments,
    consumeAttachments,
    removeAttachment,
    world.nowUnixMilliseconds,
  ]);

  if (shell === null) {
    return <div className="runtime-startup">Starting compact chat fixture…</div>;
  }
  return (
    <main className="direct-compact-chat" data-direct-compact-chat="ready">
      <ChatPane
        announcementActive
        draggable
        gridPosition={0}
        paneId={world.paneId}
        shell={shell}
        surface={surface}
      />
    </main>
  );
}
