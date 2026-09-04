import { memo, type ReactNode } from "react";

import { CloseIcon } from "./icons";
import { Button } from "./ui/button";
import type { ComposerAttachment } from "../data/composer-attachments";
import { heldAttachmentUrl } from "../data/sent-attachments";
import {
  formatByteSize,
  savedSizeLine,
  type AttachmentManifestEntry,
} from "../model/attachments";

/**
 * Attachment chips, in the composer and under a sent message.
 *
 * The composer chips describe bytes this tab holds, so an image chip carries a
 * real thumbnail from a blob handle. The transcript chips describe a manifest:
 * name, media type, size, digest, and no bytes at all. A thumbnail appears
 * there only when the digest matches something this tab sent itself and still
 * holds; every other attachment in the history is a chip and nothing more,
 * because the bytes are on the machine that ran the session and were never
 * projected.
 *
 * `img-src data: blob:` is what makes the thumbnail possible and is also the
 * whole of what it permits: no origin is listed, so an `img` element can only
 * ever resolve to bytes the page already has.
 */

function typeAndSize(mediaType: string, size: number): string {
  return `${mediaType} - ${formatByteSize(size)}`;
}

const Thumbnail = memo(function Thumbnail({
  alt,
  url,
}: Readonly<{ alt: string; url: string }>): ReactNode {
  return (
    <img
      alt={alt}
      className="h-10 w-10 shrink-0 rounded border border-line object-cover"
      src={url}
    />
  );
});

export type ComposerAttachmentChipsProps = Readonly<{
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
}>;

export function ComposerAttachmentChips({
  attachments,
  onRemove,
}: ComposerAttachmentChipsProps): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const saved = savedSizeLine(attachment);
        return (
          <li
            className={[
              "flex max-w-full items-center gap-2 rounded-md border px-2 py-1",
              attachment.refusal === null ? "border-line" : "border-danger",
            ].join(" ")}
            key={attachment.id}
          >
            {attachment.previewUrl === null ? null : (
              <Thumbnail alt={attachment.name} url={attachment.previewUrl} />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-ink">{attachment.name}</span>
              <span className="truncate text-[0.7rem] text-ink-muted">
                {typeAndSize(attachment.mediaType, attachment.bytes.byteLength)}
                {saved === null ? "" : ` (${saved})`}
              </span>
              {attachment.refusal === null ? null : (
                <span className="text-[0.7rem] text-danger">{attachment.refusal}</span>
              )}
            </span>
            <Button
              aria-label={`Remove ${attachment.name}`}
              onClick={() => { onRemove(attachment.id); }}
              size="icon"
              variant="ghost"
            >
              <CloseIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export type MessageAttachmentChipsProps = Readonly<{
  attachments: readonly AttachmentManifestEntry[];
}>;

export function MessageAttachmentChips({
  attachments,
}: MessageAttachmentChipsProps): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Message attachments" className="flex flex-wrap justify-end gap-2">
      {attachments.map((attachment) => {
        const url = attachment.kind === "image" ? heldAttachmentUrl(attachment.digest) : null;
        return (
          <li
            className="flex max-w-full items-center gap-2 rounded-md border border-line px-2 py-1"
            key={attachment.digest}
          >
            {url === null ? null : <Thumbnail alt={attachment.name} url={url} />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-ink">{attachment.name}</span>
              <span className="truncate text-[0.7rem] text-ink-muted">
                {typeAndSize(attachment.mediaType, attachment.size)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
