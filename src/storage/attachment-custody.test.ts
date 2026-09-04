import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { attachmentDigest } from "./attachment-store";
import { MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP } from "./state-store";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";
import type { SessionId } from "../domain/values";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

async function fixture(): Promise<{
  databasePath: string;
  sessionId: SessionId;
  store: StateStore;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-attachment-custody-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 1_700_000_000_000 });
  stores.push(store);
  const profile = store.createProfile("Personal");
  const session = store.createSession({
    profileId: profile.id,
    title: "Attachments",
    preset: "high",
    fastEnabled: false,
  });
  return { databasePath: paths.database, sessionId: session.id, store };
}

const attachment = (
  name: string,
  body: string,
  mediaType: "text/markdown" | "text/csv" | "text/plain" = "text/markdown",
) => ({
  byteLength: utf8(body).byteLength,
  canonicalMediaType: "text/plain" as const,
  digest: attachmentDigest(utf8(body)),
  mediaType,
  name,
});

describe("attachment custody", () => {
  test("records a manifest against the exact client message id", async () => {
    const { sessionId, store } = await fixture();
    const one = attachment("notes.md", "alpha");
    const two = attachment("rows.csv", "a,b", "text/csv");
    store.recordMessageAttachments({
      attachments: [one, two],
      sessionId,
      sourceId: "attempt_0123456789abcdef0123456789abcdef",
    });
    expect(store.messageAttachmentManifest(sessionId, "attempt_0123456789abcdef0123456789abcdef"))
      .toEqual([
        { byteLength: one.byteLength, digest: one.digest, mediaType: "text/markdown", name: "notes.md" },
        { byteLength: two.byteLength, digest: two.digest, mediaType: "text/csv", name: "rows.csv" },
      ]);
    expect(store.messageAttachmentManifest(sessionId, "queue_unrelated")).toEqual([]);
  });

  test("keeps one accounting row per digest and counts every reference", async () => {
    const { sessionId, store } = await fixture();
    const shared = attachment("notes.md", "alpha");
    store.recordMessageAttachments({ attachments: [shared], sessionId, sourceId: "attempt_a" });
    store.recordMessageAttachments({
      attachments: [{ ...shared, mediaType: "text/plain", name: "copy.txt" }],
      sessionId,
      sourceId: "attempt_b",
    });
    const custody = store.attachmentCustody(shared.digest);
    expect(custody).toEqual({
      byteLength: shared.byteLength,
      canonicalMediaType: "text/plain",
      digest: shared.digest,
      referenceCount: 2,
    });
    expect(store.listUnreferencedAttachments()).toEqual([]);
    expect(store.accountedAttachmentDigests().has(shared.digest)).toBe(true);
  });

  test("re-recording the same source is idempotent", async () => {
    const { sessionId, store } = await fixture();
    const one = attachment("notes.md", "alpha");
    store.recordMessageAttachments({ attachments: [one], sessionId, sourceId: "attempt_a" });
    store.recordMessageAttachments({ attachments: [one], sessionId, sourceId: "attempt_a" });
    expect(store.attachmentCustody(one.digest)?.referenceCount).toBe(1);
    expect(store.messageAttachmentManifest(sessionId, "attempt_a")).toHaveLength(1);
  });

  test("pruning the oldest manifest source releases its reference", async () => {
    const { sessionId, store } = await fixture();
    const oldest = attachment("oldest.md", "oldest");
    store.recordMessageAttachments({
      attachments: [oldest],
      sessionId,
      sourceId: "attempt_000000",
    });
    expect(store.attachmentCustody(oldest.digest)?.referenceCount).toBe(1);
    for (let index = 1; index <= MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP; index += 1) {
      store.recordMessageAttachments({
        attachments: [attachment("notes.md", `body-${String(index)}`)],
        sessionId,
        sourceId: `attempt_${String(index).padStart(6, "0")}`,
      });
    }
    expect(store.messageAttachmentManifest(sessionId, "attempt_000000")).toEqual([]);
    expect(store.attachmentCustody(oldest.digest)?.referenceCount).toBe(0);
    expect(store.listUnreferencedAttachments().map((row) => row.digest)).toContain(oldest.digest);
    expect(store.forgetAttachment(oldest.digest)).toBe(true);
    expect(store.attachmentCustody(oldest.digest)).toBeNull();
  });

  test("caps retained manifest sources per session, oldest first", async () => {
    const { sessionId, store } = await fixture();
    const total = MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP + 3;
    for (let index = 0; index < total; index += 1) {
      store.recordMessageAttachments({
        attachments: [attachment("notes.md", `body-${String(index)}`)],
        sessionId,
        sourceId: `attempt_${String(index).padStart(6, "0")}`,
      });
    }
    expect(store.messageAttachmentManifest(sessionId, "attempt_000000")).toEqual([]);
    expect(store.messageAttachmentManifest(sessionId, `attempt_${String(total - 1).padStart(6, "0")}`))
      .toHaveLength(1);
  });

  test("the schema stores no bytes and refuses an unaccounted digest", async () => {
    const { databasePath, sessionId, store } = await fixture();
    const one = attachment("notes.md", "alpha");
    store.recordMessageAttachments({ attachments: [one], sessionId, sourceId: "attempt_a" });
    const inspector = new Database(databasePath, { readonly: true, strict: true });
    try {
      const columns = inspector.query("PRAGMA table_info(attachments)").all() as {
        name: string;
        type: string;
      }[];
      expect(columns.map((column) => column.name).sort()).toEqual([
        "byte_length",
        "created_at",
        "digest",
        "media_type",
        "reference_count",
      ]);
      expect(columns.every((column) => column.type !== "BLOB")).toBe(true);
      const linkColumns = inspector.query("PRAGMA table_info(message_attachments)").all() as {
        name: string;
        type: string;
      }[];
      expect(linkColumns.every((column) => column.type !== "BLOB")).toBe(true);
    } finally {
      inspector.close(false);
    }
    expect(store.attachmentCustody("not-a-digest")).toBeNull();
    expect(store.forgetAttachment("not-a-digest")).toBe(false);
  });
});
