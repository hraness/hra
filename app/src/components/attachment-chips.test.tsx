import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerAttachmentChips, MessageAttachmentChips } from "./attachment-chips";
import type { ComposerAttachment } from "../data/composer-attachments";
import type { AttachmentManifestEntry } from "../model/attachments";

/*
 * The rules are proven in `model/attachments.test.ts`. This proves what the
 * chips actually emit: the name, the media type and the size, a thumbnail only
 * where bytes exist, and never a style attribute, which `style-src 'self'`
 * would refuse.
 */
const composerAttachment = (
  overrides: Partial<ComposerAttachment> = {},
): ComposerAttachment => ({
  bytes: new Uint8Array(2048),
  digest: "c".repeat(64),
  id: "attachment-1",
  kind: "image",
  mediaType: "image/webp",
  name: "shot.webp",
  previewUrl: null,
  refusal: null,
  sourceBytes: 2048,
  ...overrides,
});

const manifestEntry = (
  overrides: Partial<AttachmentManifestEntry> = {},
): AttachmentManifestEntry => ({
  digest: "d".repeat(64),
  kind: "image",
  mediaType: "image/png",
  name: "screenshot.png",
  size: 4096,
  ...overrides,
});

describe("composer chips", () => {
  test("nothing attached renders nothing at all", () => {
    expect(renderToStaticMarkup(
      <ComposerAttachmentChips attachments={[]} onRemove={() => undefined} />,
    )).toBe("");
  });

  test("a chip names the file, its type, and the size that will travel", () => {
    const markup = renderToStaticMarkup(
      <ComposerAttachmentChips
        attachments={[composerAttachment()]}
        onRemove={() => undefined}
      />,
    );
    expect(markup).toContain("shot.webp");
    expect(markup).toContain("image/webp");
    expect(markup).toContain("2.0 KiB");
    expect(markup).toContain("Remove shot.webp");
  });

  test("a downscaled image reports what it came down from", () => {
    const markup = renderToStaticMarkup(
      <ComposerAttachmentChips
        attachments={[composerAttachment({ sourceBytes: 3 * 1024 * 1024 })]}
        onRemove={() => undefined}
      />,
    );
    expect(markup).toContain("3.0 MiB down to 2.0 KiB");
  });

  test("an image chip carries a thumbnail from the tab's own bytes, and a text chip does not", () => {
    const withPreview = renderToStaticMarkup(
      <ComposerAttachmentChips
        attachments={[composerAttachment({ previewUrl: "blob:https://app.example/abc" })]}
        onRemove={() => undefined}
      />,
    );
    expect(withPreview).toContain('src="blob:https://app.example/abc"');
    expect(withPreview).toContain('alt="shot.webp"');

    const textOnly = renderToStaticMarkup(
      <ComposerAttachmentChips
        attachments={[composerAttachment({ kind: "text", mediaType: "text/csv", name: "rows.csv" })]}
        onRemove={() => undefined}
      />,
    );
    expect(textOnly).not.toContain("<img");
  });

  test("a refusal is shown on the chip it belongs to", () => {
    const markup = renderToStaticMarkup(
      <ComposerAttachmentChips
        attachments={[composerAttachment({ refusal: "huge.png is still 391 KiB after downscaling." })]}
        onRemove={() => undefined}
      />,
    );
    expect(markup).toContain("still 391 KiB after downscaling");
    expect(markup).toContain("border-danger");
  });

  test("never emits a style attribute", () => {
    const markup = renderToStaticMarkup(
      <ComposerAttachmentChips
        attachments={[composerAttachment({ previewUrl: "blob:https://app.example/abc" })]}
        onRemove={() => undefined}
      />,
    );
    expect(markup).not.toMatch(/(?<![.\w$])style\s*=/u);
  });
});

describe("transcript chips", () => {
  test("a message with no attachments renders nothing", () => {
    expect(renderToStaticMarkup(<MessageAttachmentChips attachments={[]} />)).toBe("");
  });

  test("a manifest entry renders as a chip with its name, type, and size", () => {
    const markup = renderToStaticMarkup(
      <MessageAttachmentChips attachments={[manifestEntry(), manifestEntry({
        digest: "e".repeat(64),
        kind: "text",
        mediaType: "text/markdown",
        name: "notes.md",
        size: 120,
      })]} />,
    );
    expect(markup).toContain("screenshot.png");
    expect(markup).toContain("image/png");
    expect(markup).toContain("4.0 KiB");
    expect(markup).toContain("notes.md");
    expect(markup).toContain("120 B");
  });

  /*
   * The projection carries a manifest and no bytes, so a message the reader is
   * seeing for the first time (a reload, another device, the other side of a
   * session that ran on the machine) has nothing to show a picture from. That
   * is the ordinary case, and it must never leave a broken image behind.
   */
  test("an attachment this tab does not hold renders no image element", () => {
    const markup = renderToStaticMarkup(
      <MessageAttachmentChips attachments={[manifestEntry()]} />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("screenshot.png");
  });

  test("never emits a style attribute", () => {
    const markup = renderToStaticMarkup(
      <MessageAttachmentChips attachments={[manifestEntry()]} />,
    );
    expect(markup).not.toMatch(/(?<![.\w$])style\s*=/u);
  });
});
