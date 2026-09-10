import { chmod, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { AttachmentBlobStore, parseAttachmentCleanupCandidate } from "./attachment-store";

const roots: string[] = [];
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-attachment-cleanup-")));
  roots.push(root);
  const blobs = new AttachmentBlobStore(join(root, "attachments"));
  const stored = await blobs.put("text/plain", new TextEncoder().encode("retained exact bytes"));
  if (stored.kind !== "stored") throw new Error("Expected a stored attachment");
  const candidate = { kind: "blob" as const, digest: stored.value.digest, canonicalMediaType: "text/plain" as const };
  return { root, blobs, stored: stored.value, candidate };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("bounded attachment cleanup primitives", () => {
  test("enumerates closed candidates without deleting bytes and reports a bounded scan", async () => {
    const value = await fixture();
    await writeFile(join(value.blobs.directory, "abandoned.part"), "partial", { mode: 0o600 });
    await writeFile(join(value.blobs.directory, "unrecognized.data"), "orphan", { mode: 0o600 });
    const before = await readdir(value.blobs.directory);
    const limited = await value.blobs.listCleanupCandidates(1);
    expect(limited.candidates).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    const all = await value.blobs.listCleanupCandidates(3);
    expect(all.truncated).toBe(false);
    expect(all.candidates).toContainEqual(value.candidate);
    expect(all.candidates).toContainEqual({ kind: "stale", name: "abandoned.part" });
    expect(all.candidates).toContainEqual({ kind: "stale", name: "unrecognized.data" });
    expect(await readdir(value.blobs.directory)).toEqual(before);
    await expect(value.blobs.listCleanupCandidates(0)).rejects.toThrow("ATTACHMENT_CLEANUP_INVALID_LIMIT");
    await expect(value.blobs.listCleanupCandidates(100_001)).rejects.toThrow("ATTACHMENT_CLEANUP_INVALID_LIMIT");
  });

  test("rechecks file age after enumeration rather than trusting the candidate snapshot", async () => {
    const value = await fixture();
    const old = new Date(1_000);
    await utimes(value.stored.path, old, old);
    const enumeration = await value.blobs.listCleanupCandidates();
    expect(enumeration.candidates).toEqual([value.candidate]);
    await utimes(value.stored.path, new Date(3_000), new Date(3_000));
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: 2_000 }))
      .toEqual({ kind: "retained", reason: "young" });
    expect(await value.blobs.read(value.stored.digest, "text/plain")).toEqual(new TextEncoder().encode("retained exact bytes"));
    await utimes(value.stored.path, old, old);
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: 2_000 })).toEqual({ kind: "deleted" });
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: 2_000 })).toEqual({ kind: "absent" });
  });

  test("existing equal-sized puts do not manufacture a fresh timestamp or cleanup lease", async () => {
    const value = await fixture();
    const old = new Date(1_000);
    await utimes(value.stored.path, old, old);
    await value.blobs.put("text/plain", new TextEncoder().encode("retained exact bytes"));
    expect((await lstat(value.stored.path)).mtimeMs).toBe(1_000);
    // This primitive has no reference or pin authority. Its future storage
    // caller must supply that exclusion before invoking an age-eligible unlink.
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: 2_000 })).toEqual({ kind: "deleted" });
  });

  test("refuses symlinks, directories and files outside private blob custody", async () => {
    const value = await fixture();
    const outside = join(value.root, "outside.txt");
    await writeFile(outside, "must survive", { mode: 0o600 });
    await rm(value.stored.path);
    await symlink(outside, value.stored.path);
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
      .toEqual({ kind: "retained", reason: "unsafe_file" });
    expect((await lstat(value.stored.path)).isSymbolicLink()).toBe(true);
    expect((await lstat(outside)).size).toBe(12);
    await rm(value.stored.path);
    await mkdir(value.stored.path, { mode: 0o700 });
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
      .toEqual({ kind: "retained", reason: "unsafe_file" });
    await rm(value.stored.path, { recursive: true });
    await writeFile(value.stored.path, "not private", { mode: 0o644 });
    await chmod(value.stored.path, 0o644);
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
      .toEqual({ kind: "retained", reason: "unsafe_file" });
  });

  test("requires a grace cutoff for stale names and never reclassifies a real blob as stale", async () => {
    const value = await fixture();
    const candidate = { kind: "stale" as const, name: "abandoned.part" };
    const path = join(value.blobs.directory, candidate.name);
    await writeFile(path, "partial", { mode: 0o600 });
    expect(() => value.blobs.unlinkCleanupCandidateSync(candidate, { notNewerThan: null }))
      .toThrow("ATTACHMENT_CLEANUP_INVALID_CUTOFF");
    await utimes(path, new Date(1_000), new Date(1_000));
    expect(value.blobs.unlinkCleanupCandidateSync(candidate, { notNewerThan: 2_000 })).toEqual({ kind: "deleted" });
    expect(() => parseAttachmentCleanupCandidate({ kind: "stale", name: `${value.stored.digest}.txt` }))
      .toThrow("ATTACHMENT_CLEANUP_INVALID_CANDIDATE");
    expect(await value.blobs.has(value.stored.digest, "text/plain")).toBe(true);
  });

  test("refuses case-insensitive blob aliases before stale-file deletion", async () => {
    const value = await fixture();
    for (const name of [`${value.stored.digest}.TXT`, `${value.stored.digest.toUpperCase()}.txt`]) {
      expect(() => value.blobs.unlinkCleanupCandidateSync({ kind: "stale", name }, { notNewerThan: Date.now() + 1_000 }))
        .toThrow("ATTACHMENT_CLEANUP_INVALID_CANDIDATE");
      expect(() => parseAttachmentCleanupCandidate({ kind: "stale", name }))
        .toThrow("ATTACHMENT_CLEANUP_INVALID_CANDIDATE");
      expect(await value.blobs.read(value.stored.digest, "text/plain"))
        .toEqual(new TextEncoder().encode("retained exact bytes"));
    }
  });

  test("legacy unaccounted cleanup preserves noncanonical case aliases of accounted blobs", async () => {
    const value = await fixture();
    const aliased = join(value.blobs.directory, `${value.stored.digest.toUpperCase()}.TXT`);
    await rename(value.stored.path, aliased);
    await utimes(aliased, new Date(1_000), new Date(1_000));
    expect(await value.blobs.sweepUnaccounted(new Set([value.stored.digest]), 1_000, 5_000)).toBe(0);
    expect((await lstat(aliased)).isFile()).toBe(true);
    expect(await value.blobs.listCleanupCandidates()).toEqual({ candidates: [], truncated: false });
  });

  test.each([".", "..", "../outside.txt", "/outside.txt", "inside/outside.txt", "inside\\outside.txt", "bad\0name", "bad\uD800name", " ".repeat(256), "🍀".repeat(64)])(
    "rejects unsafe stale filename %j without normalization", (name) => {
      expect(() => parseAttachmentCleanupCandidate({ kind: "stale", name }))
        .toThrow("ATTACHMENT_CLEANUP_INVALID_CANDIDATE");
    },
  );

  test("preserves admitted Unicode and whitespace filenames exactly", () => {
    expect(parseAttachmentCleanupCandidate({ kind: "stale", name: "  🍀.part " }))
      .toEqual({ kind: "stale", name: "  🍀.part " });
  });

  test("does not unlink a blob with another hard-link owner", async () => {
    const value = await fixture();
    const other = join(value.root, "other-owner.txt");
    await link(value.stored.path, other);
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
      .toEqual({ kind: "retained", reason: "unsafe_file" });
    expect((await lstat(value.stored.path)).nlink).toBe(2);
    expect((await lstat(other)).nlink).toBe(2);
  });

  test.skipIf(process.getuid?.() === 0)("sanitizes real permission failures without deleting the candidate", async () => {
    const value = await fixture();
    try {
      await chmod(value.blobs.directory, 0o500);
      expect(() => value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
        .toThrow("ATTACHMENT_CLEANUP_UNLINK_FAILED");
      await chmod(value.blobs.directory, 0o000);
      expect(() => value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
        .toThrow("ATTACHMENT_CLEANUP_INSPECT_FAILED");
      await chmod(value.blobs.directory, 0o100);
      // Bun's Darwin realpath may itself need read permission. Either native
      // failure stage must remain a closed, path-free cleanup refusal.
      await expect(value.blobs.listCleanupCandidates()).rejects.toMatchObject({
        name: "AttachmentCleanupError",
        message: expect.stringMatching(/^ATTACHMENT_CLEANUP_(INSPECT|ENUMERATION)_FAILED$/u),
      });
    } finally {
      await chmod(value.blobs.directory, 0o700);
    }
    expect(await value.blobs.read(value.stored.digest, "text/plain"))
      .toEqual(new TextEncoder().encode("retained exact bytes"));
  });

  test("rejects noncanonical media, surplus fields and invalid cutoffs without unlinking", async () => {
    const value = await fixture();
    for (const candidate of [
      { ...value.candidate, canonicalMediaType: "text/markdown" },
      { ...value.candidate, path: value.stored.path },
      { ...value.candidate, digest: value.stored.digest.toUpperCase() },
    ]) expect(() => parseAttachmentCleanupCandidate(candidate)).toThrow("ATTACHMENT_CLEANUP_INVALID_CANDIDATE");
    for (const notNewerThan of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(() => value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan }))
        .toThrow("ATTACHMENT_CLEANUP_INVALID_CUTOFF");
    }
    expect(await value.blobs.has(value.stored.digest, "text/plain")).toBe(true);
  });

  test("does not create a missing directory and refuses a replaced directory or unsafe parent", async () => {
    const value = await fixture();
    await rm(value.blobs.directory, { recursive: true });
    expect(await value.blobs.listCleanupCandidates()).toEqual({ candidates: [], truncated: false });
    expect(value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null })).toEqual({ kind: "absent" });
    expect(await readdir(value.root)).toEqual([]);
    const other = join(value.root, "other");
    await mkdir(other, { mode: 0o700 });
    await symlink(other, value.blobs.directory);
    expect(() => value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
      .toThrow("ATTACHMENT_CLEANUP_UNSAFE_DIRECTORY");
    await rm(value.blobs.directory);
    await chmod(value.root, 0o755);
    expect(() => value.blobs.unlinkCleanupCandidateSync(value.candidate, { notNewerThan: null }))
      .toThrow("ATTACHMENT_CLEANUP_UNSAFE_DIRECTORY");
    await chmod(value.root, 0o700);
  });
});
