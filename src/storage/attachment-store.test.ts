import { lstat, mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { attachmentDigest, AttachmentBlobStore } from "./attachment-store";

const roots: string[] = [];

const store = async (): Promise<AttachmentBlobStore> => {
  // macOS resolves /var through a symlink, and private-directory custody
  // refuses a traversed path, so the fixture root is canonicalized first.
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-attachments-")));
  roots.push(root);
  return new AttachmentBlobStore(join(root, "attachments"));
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const png = (): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("AttachmentBlobStore", () => {
  test("refuses a relative directory", () => {
    expect(() => new AttachmentBlobStore("attachments")).toThrow(
      "The attachment store directory must be absolute.",
    );
  });

  test("stores bytes user-only under a content-addressed, extension-bearing name", async () => {
    const blobs = await store();
    const bytes = png();
    const outcome = await blobs.put("image/png", bytes);
    expect(outcome.kind).toBe("stored");
    if (outcome.kind !== "stored") return;
    expect(outcome.value.digest).toBe(attachmentDigest(bytes));
    expect(outcome.value.canonicalMediaType).toBe("image/png");
    expect(outcome.value.path.endsWith(`${outcome.value.digest}.png`)).toBe(true);
    const metadata = await lstat(outcome.value.path);
    expect(metadata.mode & 0o777).toBe(0o600);
    const directory = await lstat(blobs.directory);
    expect(directory.mode & 0o077).toBe(0);
  });

  test("stores every text-ish declaration under one canonical blob", async () => {
    const blobs = await store();
    const bytes = utf8("a,b\n1,2\n");
    const asCsv = await blobs.put("text/csv", bytes);
    const asMarkdown = await blobs.put("text/markdown", bytes);
    expect(asCsv.kind).toBe("stored");
    expect(asMarkdown.kind).toBe("stored");
    if (asCsv.kind !== "stored" || asMarkdown.kind !== "stored") return;
    expect(asMarkdown.value.path).toBe(asCsv.value.path);
    expect(asMarkdown.value.canonicalMediaType).toBe("text/plain");
    expect((await readdir(blobs.directory)).length).toBe(1);
  });

  test("refuses bytes that do not match their declared media type", async () => {
    const blobs = await store();
    const refused = await blobs.put("image/png", utf8("plain words"));
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.reason).toBe("MEDIA_TYPE_MISMATCH");
    expect(await readdir(blobs.directory).catch(() => [])).toEqual([]);
  });

  test("reads bytes back and re-proves the digest", async () => {
    const blobs = await store();
    const bytes = utf8("hello attachments");
    const stored = await blobs.put("text/plain", bytes);
    if (stored.kind !== "stored") throw new Error("expected a stored blob");
    expect(await blobs.read(stored.value.digest, "text/plain")).toEqual(bytes);
    expect(await blobs.has(stored.value.digest, "text/plain")).toBe(true);
    await blobs.remove(stored.value.digest, "text/plain");
    expect(await blobs.has(stored.value.digest, "text/plain")).toBe(false);
  });

  test("refuses a blob whose bytes were replaced under its digest name", async () => {
    const blobs = await store();
    const stored = await blobs.put("text/plain", utf8("original"));
    if (stored.kind !== "stored") throw new Error("expected a stored blob");
    await writeFile(stored.value.path, "tampered", { mode: 0o600 });
    await expect(blobs.read(stored.value.digest, "text/plain")).rejects.toThrow(
      "ATTACHMENT_BLOB_UNSAFE",
    );
  });

  test("sweeps only unaccounted blobs that are older than the grace window", async () => {
    const blobs = await store();
    const kept = await blobs.put("text/plain", utf8("kept"));
    const orphan = await blobs.put("text/plain", utf8("orphan"));
    const fresh = await blobs.put("text/plain", utf8("fresh"));
    if (kept.kind !== "stored" || orphan.kind !== "stored" || fresh.kind !== "stored") {
      throw new Error("expected three stored blobs");
    }
    const old = new Date(Date.now() - 7_200_000);
    await utimes(kept.value.path, old, old);
    await utimes(orphan.value.path, old, old);
    const removed = await blobs.sweepUnaccounted(
      new Set([kept.value.digest]),
      3_600_000,
      Date.now(),
    );
    expect(removed).toBe(1);
    expect(await blobs.has(kept.value.digest, "text/plain")).toBe(true);
    expect(await blobs.has(fresh.value.digest, "text/plain")).toBe(true);
    expect(await blobs.has(orphan.value.digest, "text/plain")).toBe(false);
  });
});
