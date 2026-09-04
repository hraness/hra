import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  heldAttachmentUrl,
  holdSentAttachment,
  maximumHeldAttachments,
  releaseHeldAttachments,
} from "./sent-attachments";
import { MessageAttachmentChips } from "../components/attachment-chips";
import type { AttachmentManifestEntry } from "../model/attachments";

const digestOf = (index: number): string =>
  index.toString(16).padStart(2, "0").repeat(32);

const hold = (index: number): void => {
  holdSentAttachment({
    bytes: new Uint8Array([index]),
    digest: digestOf(index),
    mediaType: "image/png",
  });
};

afterEach(() => { releaseHeldAttachments(); });

describe("the bytes this tab holds", () => {
  test("an attachment this tab never sent has nothing to show", () => {
    expect(heldAttachmentUrl(digestOf(1))).toBeNull();
  });

  test("a held attachment resolves to a blob handle, addressed by digest", () => {
    hold(1);
    const url = heldAttachmentUrl(digestOf(1));
    expect(url).toMatch(/^blob:/u);
    expect(heldAttachmentUrl(digestOf(2))).toBeNull();
  });

  test("holding the same digest twice keeps one handle", () => {
    hold(1);
    const first = heldAttachmentUrl(digestOf(1));
    hold(1);
    expect(heldAttachmentUrl(digestOf(1))).toBe(first);
  });

  test("the store is bounded and evicts the oldest", () => {
    for (let index = 0; index < maximumHeldAttachments + 3; index += 1) hold(index);
    expect(heldAttachmentUrl(digestOf(0))).toBeNull();
    expect(heldAttachmentUrl(digestOf(2))).toBeNull();
    expect(heldAttachmentUrl(digestOf(maximumHeldAttachments + 2))).not.toBeNull();
  });

  test("releasing drops everything, which is what locking the account key does", () => {
    hold(1);
    releaseHeldAttachments();
    expect(heldAttachmentUrl(digestOf(1))).toBeNull();
  });
});

describe("what the transcript does with them", () => {
  const entry: AttachmentManifestEntry = {
    digest: digestOf(1),
    kind: "image",
    mediaType: "image/png",
    name: "screenshot.png",
    size: 4096,
  };

  test("an image whose bytes this tab holds renders inline", () => {
    hold(1);
    const markup = renderToStaticMarkup(<MessageAttachmentChips attachments={[entry]} />);
    expect(markup).toContain("<img");
    expect(markup).toContain('alt="screenshot.png"');
    expect(markup).toContain(`src="${heldAttachmentUrl(digestOf(1)) ?? ""}"`);
  });

  test("the same manifest entry without the bytes renders only a chip", () => {
    const markup = renderToStaticMarkup(<MessageAttachmentChips attachments={[entry]} />);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("screenshot.png");
  });

  /*
   * A text attachment is never rendered inline even when the bytes are here:
   * the chip says what it is, and the file's own content belongs to the machine
   * that ran the session, not to a preview in the scroll.
   */
  test("a text attachment is a chip even when its bytes are held", () => {
    holdSentAttachment({
      bytes: new TextEncoder().encode("a,b,c"),
      digest: digestOf(2),
      mediaType: "text/csv",
    });
    const markup = renderToStaticMarkup(
      <MessageAttachmentChips
        attachments={[{
          digest: digestOf(2),
          kind: "text",
          mediaType: "text/csv",
          name: "rows.csv",
          size: 5,
        }]}
      />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("rows.csv");
  });
});
