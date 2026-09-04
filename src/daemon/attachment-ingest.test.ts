import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTACHMENT_MAX_COUNT,
  type AttachmentReference,
} from "../domain/attachments";
import { attachmentDigest, AttachmentBlobStore } from "../storage/attachment-store";
import { AttachmentIngestError, ingestAttachments } from "./attachment-ingest";
import { resolveMessageAttachments } from "./attachments";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const machO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

async function fixture(): Promise<{ blobs: AttachmentBlobStore; cwd: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-attachment-ingest-")));
  roots.push(root);
  return { blobs: new AttachmentBlobStore(join(root, "state", "attachments")), cwd: root };
}

describe("attachment ingest", () => {
  test("stores each file and returns digest references in order", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "diagram.png"), png);
    await writeFile(join(cwd, "notes.md"), "# hello");
    const references = await ingestAttachments(blobs, ["diagram.png", "notes.md"], cwd);
    expect(references).toEqual([
      {
        byteLength: png.byteLength,
        digest: attachmentDigest(png),
        mediaType: "image/png",
        name: "diagram.png",
      },
      {
        byteLength: 7,
        digest: attachmentDigest(utf8("# hello")),
        mediaType: "text/markdown",
        name: "notes.md",
      },
    ]);
    expect(await blobs.has(references[0]?.digest ?? "", "image/png")).toBe(true);
  });

  test("refuses an unreviewed extension before it opens the file", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "payload.dmg"), machO);
    await expect(ingestAttachments(blobs, ["payload.dmg"], cwd)).rejects.toThrow(
      "payload.dmg is not an accepted attachment type",
    );
  });

  test("refuses an executable renamed to a text extension", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "innocent.txt"), machO);
    await expect(ingestAttachments(blobs, ["innocent.txt"], cwd)).rejects.toThrow(
      "innocent.txt was refused",
    );
  });

  test("refuses an empty file, a missing file, and a symbolic link", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "empty.txt"), "");
    await writeFile(join(cwd, "real.txt"), "content");
    await symlink(join(cwd, "real.txt"), join(cwd, "link.txt"));
    await expect(ingestAttachments(blobs, ["empty.txt"], cwd)).rejects.toThrow("empty");
    await expect(ingestAttachments(blobs, ["absent.txt"], cwd)).rejects.toThrow(
      "could not be read as an attachment",
    );
    await expect(ingestAttachments(blobs, ["link.txt"], cwd)).rejects.toThrow(
      "could not be read as an attachment",
    );
  });

  test("refuses more attachments than one message may carry", async () => {
    const { blobs, cwd } = await fixture();
    const paths: string[] = [];
    for (let index = 0; index <= ATTACHMENT_MAX_COUNT; index += 1) {
      const name = `f${String(index)}.txt`;
      await writeFile(join(cwd, name), `body ${String(index)}`);
      paths.push(name);
    }
    await expect(ingestAttachments(blobs, paths, cwd)).rejects.toBeInstanceOf(
      AttachmentIngestError,
    );
  });
});

describe("attachment resolution", () => {
  test("prepares images as base64 and text as inlined text", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "diagram.png"), png);
    await writeFile(join(cwd, "notes.md"), "# hello");
    const references = await ingestAttachments(blobs, ["diagram.png", "notes.md"], cwd);
    const resolved = await resolveMessageAttachments(blobs, references);
    expect(resolved.kind).toBe("prepared");
    if (resolved.kind !== "prepared") return;
    const [image, text] = resolved.values;
    expect(image?.kind).toBe("image");
    if (image?.kind === "image") {
      expect(image.mediaType).toBe("image/png");
      expect(image.base64).toBe(Buffer.from(png).toString("base64"));
      expect(image.path.endsWith(".png")).toBe(true);
    }
    expect(text?.kind).toBe("text");
    if (text?.kind === "text") {
      expect(text.mediaType).toBe("text/markdown");
      expect(text.text).toBe("# hello");
    }
    expect(resolved.stored.map((entry) => entry.canonicalMediaType))
      .toEqual(["image/png", "text/plain"]);
  });

  test("refuses a digest that is not in custody on this machine", async () => {
    const { blobs } = await fixture();
    const reference: AttachmentReference = {
      byteLength: 4,
      digest: attachmentDigest(utf8("gone")),
      mediaType: "text/plain",
      name: "gone.txt",
    };
    const resolved = await resolveMessageAttachments(blobs, [reference]);
    expect(resolved.kind).toBe("refused");
    if (resolved.kind === "refused") expect(resolved.code).toBe("ATTACHMENT_MISSING");
  });

  test("refuses a reference whose declared length is not the stored length", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "notes.md"), "# hello");
    const [reference] = await ingestAttachments(blobs, ["notes.md"], cwd);
    if (reference === undefined) throw new Error("expected one reference");
    const resolved = await resolveMessageAttachments(blobs, [
      { ...reference, byteLength: reference.byteLength + 1 },
    ]);
    expect(resolved.kind).toBe("refused");
    if (resolved.kind === "refused") expect(resolved.code).toBe("ATTACHMENT_LENGTH_MISMATCH");
  });

  test("refuses bytes whose declared media type no longer matches", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "notes.md"), "# hello");
    const [reference] = await ingestAttachments(blobs, ["notes.md"], cwd);
    if (reference === undefined) throw new Error("expected one reference");
    const resolved = await resolveMessageAttachments(blobs, [
      { ...reference, mediaType: "application/json" },
    ]);
    expect(resolved.kind).toBe("refused");
    if (resolved.kind === "refused") expect(resolved.code).toBe("ATTACHMENT_INVALID_JSON");
  });

  test("refuses a blob whose bytes were replaced under its digest name", async () => {
    const { blobs, cwd } = await fixture();
    await writeFile(join(cwd, "notes.md"), "# hello");
    const [reference] = await ingestAttachments(blobs, ["notes.md"], cwd);
    if (reference === undefined) throw new Error("expected one reference");
    const path = blobs.pathFor(reference.digest, "text/plain");
    await writeFile(path, "tampered bytes");
    await chmod(path, 0o600);
    const resolved = await resolveMessageAttachments(blobs, [reference]);
    expect(resolved.kind).toBe("refused");
    if (resolved.kind === "refused") expect(resolved.code).toBe("ATTACHMENT_MISSING");
  });
});
