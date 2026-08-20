import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  CHAT_ATTACHMENT_MAX_CHUNK_BYTES,
  CHAT_ATTACHMENT_MAX_PANE_READY_BYTES,
  CHAT_ATTACHMENT_PREVIEW_MAX_BYTES,
  ChatAttachmentVaultError,
} from "../src/attachments/contracts";
import {
  NativeChatImageNormalizer,
  type ChatImageNormalizer,
  type NativeImageNormalizerProcess,
  type NativeImageNormalizerSpawn,
  type NativeImageNormalizerReceipt,
} from "../src/attachments/normalizer";
import { SQLiteChatAttachmentVault } from "../src/attachments/vault";
import { RootTurnRoutingSQLiteAuthorityV1 } from
  "../src/harness/root-turn-routing-sqlite-v1";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";
import { operationReceiptKeyByteLength } from "../src/state/operation-receipt-key";
import {
  ProviderThreadArchiveJournalV57,
  providerThreadArchiveCompleteInventoryDigestV57,
} from "../src/state/provider-thread-archive-journal-v57";

const PANE = "pane_attachmentvault1";
const ACCOUNT = "acct_attachmentvault1";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const KEY_DIGEST = "b".repeat(64);

test("native normalizer output overflow is reaped before failure returns", async () => {
  const killed = deferredVoid();
  let resolveExit: ((exitCode: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn: NativeImageNormalizerSpawn = (): NativeImageNormalizerProcess => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited,
    kill: () => killed.resolve(),
  });
  const normalizer = new NativeChatImageNormalizer("/usr/bin/true", 5_000, spawn);
  const pending = normalizer.normalize(
    "/private/tmp/hra-normalizer-input",
    "/private/tmp/hra-normalizer-output",
  );
  await killed.promise;
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  if (resolveExit === undefined) throw new Error("exit resolver was not installed");
  resolveExit(137);
  expect(await rejectionOf(pending)).toMatchObject({ code: "corrupt" });
  expect(settled).toBe(true);
});

test("native normalizer rejects foreign stderr beside a valid success receipt", async () => {
  const encoder = new TextEncoder();
  const stream = (value: string) => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
  const receipt = `${JSON.stringify({
    schemaVersion: 1,
    mediaType: "image/png",
    sourceBytes: 1,
    canonical: {
      width: 1,
      height: 1,
      bytes: 1,
      sha256: "a".repeat(64),
    },
    preview: {
      width: 1,
      height: 1,
      bytes: 1,
      sha256: "b".repeat(64),
    },
  })}\n`;
  const spawn: NativeImageNormalizerSpawn = (): NativeImageNormalizerProcess => ({
    stdout: stream(receipt),
    stderr: stream("IOServiceMatchingfailed for: AppleM2ScalerParavirtDriver\n"),
    exited: Promise.resolve(0),
    kill: () => undefined,
  });
  const normalizer = new NativeChatImageNormalizer("/usr/bin/true", 5_000, spawn);

  expect(await rejectionOf(normalizer.normalize(
    "/private/tmp/hra-normalizer-input",
    "/private/tmp/hra-normalizer-output",
  ))).toMatchObject({ code: "corrupt" });
});

test("generic files upload in bounded exact chunks and require a provider lease", async () => {
  await withVault(async ({ vault, root, database }) => {
    const bytes = Buffer.from("private generic file\n", "utf8");
    const attachmentId = "attachment_vaultgeneric01";
    const uploadId = "upload_vaultgeneric01";
    const begun = await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "../../report.TXT",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
    });
    expect(begun).toMatchObject({
      changed: true,
      attachment: {
        id: attachmentId,
        revision: 2,
        displayName: "report.TXT",
        kind: "file",
        state: "uploading",
      },
    });
    const appended = await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(1),
    });
    expect(appended.attachment.revision).toBe(4);
    expect((await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(2),
    })).changed).toBe(false);
    expect(vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: Buffer.from("changed").toString("base64"),
      now: later(3),
    })).rejects.toMatchObject({ code: "conflict" });

    const ready = await vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(bytes),
      now: later(4),
    });
    expect(ready).toMatchObject({
      changed: true,
      attachment: {
        revision: 6,
        state: "ready",
        previewAvailable: false,
      },
    });
    expect(vault.projectPane({
      paneId: PANE,
      referencedAttachmentIds: [],
      now: later(5),
    }).drafts).toEqual([ready.attachment]);

    const bindingId = "attbinding_vaultgeneric01";
    const lease = vault.acquireProviderLease({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentIds: [attachmentId],
      now: later(6),
    });
    expect(lease).toEqual({ bindingId, revision: 1, state: "active", changed: true });
    const descriptor = await vault.providerDescriptor({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentId,
      now: later(7),
    });
    expect(descriptor).toMatchObject({
      attachmentId,
      kind: "file",
      displayName: "report.TXT",
      mediaType: "text/plain",
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    expect(descriptor.readPath.startsWith(`${root}/objects/${attachmentId}/`)).toBe(true);
    expect(await readFile(descriptor.readPath)).toEqual(bytes);
    expect((await stat(descriptor.readPath)).mode & 0o777).toBe(0o600);

    expect(vault.releaseProviderBindingAfterResumeContained({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      expectedRevision: 1,
      containmentReceipt: "terminal-rollout-forgotten-0001",
      now: later(8),
    })).toMatchObject({ revision: 2, state: "released", changed: true });
    expect((await vault.removeAttachment({
      paneId: PANE,
      attachmentId,
      expectedRevision: 6,
      now: later(9),
    })).changed).toBe(true);
    expect((await vault.removeAttachment({
      paneId: PANE,
      attachmentId,
      expectedRevision: 6,
      now: later(10),
    })).changed).toBe(false);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments
    `).get()).toEqual({ count: 0 });
  });
});

test("a reopened receiving draft can be removed without recovering its upload identity", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_reopenremove01";
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId: "upload_reopenremove01",
      kind: "file",
      displayName: "partial.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 12,
      now: NOW,
    });
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(reopened.projectPane({
      paneId: PANE,
      referencedAttachmentIds: [],
      now: later(1),
    }).drafts).toEqual([
      expect.objectContaining({
        id: attachmentId,
        revision: 2,
        state: "uploading",
      }),
    ]);
    expect(await reopened.removeAttachment({
      paneId: PANE,
      attachmentId,
      expectedRevision: 2,
      now: later(2),
    })).toEqual({ attachmentId, removed: true, changed: true });
    expect((await reopened.removeAttachment({
      paneId: PANE,
      attachmentId,
      expectedRevision: 2,
      now: later(3),
    })).changed).toBe(false);
  });
});

test("provider descriptor cannot cross a concurrent release or ambiguity fence", async () => {
  for (const transition of ["release", "ambiguous"] as const) {
    const entered = deferredVoid();
    const resume = deferredVoid();
    await withVault(async ({ vault, database }) => {
      const attachmentId = `attachment_vaultrace${transition}`;
      const bindingId = `attbinding_vaultrace${transition}`;
      await uploadReady(vault, {
        attachmentId,
        uploadId: `upload_vaultrace${transition}`,
        kind: "file",
        bytes: Buffer.from(`race-${transition}`, "utf8"),
        displayName: `${transition}.txt`,
        mediaType: "text/plain",
      });
      vault.acquireProviderLease({
        bindingId,
        bindingKeyDigest: KEY_DIGEST,
        paneId: PANE,
        attachmentIds: [attachmentId],
        now: later(3),
      });
      const pending = vault.providerDescriptor({
        bindingId,
        bindingKeyDigest: KEY_DIGEST,
        paneId: PANE,
        attachmentId,
        now: later(4),
      });
      await entered.promise;
      if (transition === "release") {
        vault.releaseProviderBindingAfterResumeContained({
          bindingId,
          bindingKeyDigest: KEY_DIGEST,
          paneId: PANE,
          expectedRevision: 1,
          containmentReceipt: "descriptor-race-resume-contained",
          now: later(5),
        });
      } else {
        vault.markProviderBindingAmbiguous({
          bindingId,
          bindingKeyDigest: KEY_DIGEST,
          paneId: PANE,
          expectedRevision: 1,
          ambiguityReceipt: "descriptor-race-effect-unknown",
          now: later(5),
        });
      }
      resume.resolve();
      let outcome: unknown;
      try {
        outcome = await pending;
      } catch (error: unknown) {
        outcome = error;
      }
      expect(outcome).toMatchObject({ code: "invalid_state" });
      expect(database.query(`
        SELECT state FROM chat_attachments WHERE attachment_id = ?1
      `).get(attachmentId)).toEqual({ state: "ready" });
    }, new FixtureNormalizer(), async (checkpoint) => {
      if (checkpoint !== "provider-verified") return;
      entered.resolve();
      await resume.promise;
    });
  }
});

test("provider descriptor and preview expose nothing across a pane archive cut", async () => {
  for (const read of ["provider", "preview"] as const) {
    const entered = deferredVoid();
    const resume = deferredVoid();
    await withVault(async ({ vault, database }) => {
      const attachmentId = `attachment_vaultarchread${read}`;
      const bindingId = `attbinding_vaultarchread${read}`;
      const ready = await uploadReady(vault, {
        attachmentId,
        uploadId: `upload_vaultarchread${read}`,
        kind: "image",
        bytes: Buffer.from(`archive-read-${read}`, "utf8"),
        displayName: `${read}.png`,
        mediaType: "image/png",
      });
      let pending: Promise<unknown>;
      if (read === "provider") {
        vault.acquireProviderLease({
          bindingId,
          bindingKeyDigest: KEY_DIGEST,
          paneId: PANE,
          attachmentIds: [attachmentId],
          now: later(3),
        });
        pending = vault.providerDescriptor({
          bindingId,
          bindingKeyDigest: KEY_DIGEST,
          paneId: PANE,
          attachmentId,
          now: later(4),
        });
      } else {
        pending = vault.readPreview({
          paneId: PANE,
          attachmentId,
          expectedRevision: ready.attachment.revision,
          relationship: { kind: "draft" },
          now: later(4),
        });
      }
      await entered.promise;
      archivePaneInTransaction(
        vault,
        database,
        `archive-read-${read}-resume-contained`,
        later(5),
      );
      resume.resolve();
      expect(await rejectionOf(pending)).toMatchObject({ code: "not_found" });
      await vault.archivePaneAfterResumeContained({
        paneId: PANE,
        containmentReceipt: `archive-read-${read}-resume-contained`,
        now: later(5),
      });
    }, new FixtureNormalizer(), async (checkpoint) => {
      if (checkpoint !== `${read === "provider" ? "provider-verified" : "preview-read"}`) {
        return;
      }
      entered.resolve();
      await resume.promise;
    });
  }
});

test("begin cannot advance to receiving across a pane archive cut", async () => {
  const entered = deferredVoid();
  const resume = deferredVoid();
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultarchbegin1";
    const pending = vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId: "upload_vaultarchbegin1",
      kind: "file",
      displayName: "begin.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: NOW,
    });
    await entered.promise;
    archivePaneInTransaction(
      vault,
      database,
      "archive-begin-resume-contained",
      later(1),
    );
    resume.resolve();
    expect(await rejectionOf(pending)).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state, received_input_bytes FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "creating", received_input_bytes: 0 });
    await vault.archivePaneAfterResumeContained({
      paneId: PANE,
      containmentReceipt: "archive-begin-resume-contained",
      now: later(1),
    });
  }, new FixtureNormalizer(), async (checkpoint) => {
    if (checkpoint !== "begin-created") return;
    entered.resolve();
    await resume.promise;
  });
});

test("append cannot commit bytes across a pane archive cut", async () => {
  const entered = deferredVoid();
  const resume = deferredVoid();
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultarchappend1";
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId: "upload_vaultarchappend1",
      kind: "file",
      displayName: "append.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: NOW,
    });
    const pending = vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId: "upload_vaultarchappend1",
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: Buffer.from("a", "utf8").toString("base64"),
      now: later(1),
    });
    await entered.promise;
    archivePaneInTransaction(
      vault,
      database,
      "archive-append-resume-contained",
      later(2),
    );
    resume.resolve();
    expect(await rejectionOf(pending)).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state, received_input_bytes FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "receiving", received_input_bytes: 0 });
    await vault.archivePaneAfterResumeContained({
      paneId: PANE,
      containmentReceipt: "archive-append-resume-contained",
      now: later(2),
    });
  }, new FixtureNormalizer(), async (checkpoint) => {
    if (checkpoint !== "chunk-written") return;
    entered.resolve();
    await resume.promise;
  });
});

test("finalize cannot publish ready custody across a pane archive cut", async () => {
  const entered = deferredVoid();
  const resume = deferredVoid();
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultarchfinal1";
    const bytes = Buffer.from("f", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId: "upload_vaultarchfinal1",
      kind: "file",
      bytes,
      displayName: "final.txt",
      mediaType: "text/plain",
    });
    const pending = vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId: "upload_vaultarchfinal1",
      expectedRevision: 4,
      inputSha256: sha256(bytes),
      now: later(2),
    });
    await entered.promise;
    archivePaneInTransaction(
      vault,
      database,
      "archive-finalize-resume-contained",
      later(3),
    );
    resume.resolve();
    expect(await rejectionOf(pending)).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state, ready_at, finalize_request_revision
      FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({
      state: "receiving",
      ready_at: null,
      finalize_request_revision: null,
    });
    await vault.archivePaneAfterResumeContained({
      paneId: PANE,
      containmentReceipt: "archive-finalize-resume-contained",
      now: later(3),
    });
  }, new FixtureNormalizer(), async (checkpoint) => {
    if (checkpoint !== "finalize-verified") return;
    entered.resolve();
    await resume.promise;
  });
});

test("pane archive fences exact begin, append, and finalize replays", async () => {
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultarchreplay1";
    const uploadId = "upload_vaultarchreplay1";
    const bytes = Buffer.from("replay", "utf8");
    await uploadReady(vault, {
      attachmentId,
      uploadId,
      kind: "file",
      bytes,
      displayName: "replay.txt",
      mediaType: "text/plain",
    });
    archivePaneInTransaction(
      vault,
      database,
      "archive-replay-resume-contained",
      later(3),
    );
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "replay.txt",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
    }))).toMatchObject({ code: "invalid_state" });
    expect(await rejectionOf(vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(1),
    }))).toMatchObject({ code: "invalid_state" });
    expect(await rejectionOf(vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(bytes),
      now: later(2),
    }))).toMatchObject({ code: "invalid_state" });
    await vault.archivePaneAfterResumeContained({
      paneId: PANE,
      containmentReceipt: "archive-replay-resume-contained",
      now: later(3),
    });
  });
});

test("nonfinal chunks must be exactly 512 KiB and admit at most 48 ordinals", async () => {
  await withVault(async ({ vault }) => {
    const attachmentId = "attachment_vaultchunking01";
    const uploadId = "upload_vaultchunking01";
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "bounded.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: CHAT_ATTACHMENT_MAX_CHUNK_BYTES + 1,
      now: NOW,
    });
    expect(vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: Buffer.from([1]).toString("base64"),
      now: later(1),
    })).rejects.toMatchObject({ code: "invalid_input" });
    const first = Buffer.alloc(CHAT_ATTACHMENT_MAX_CHUNK_BYTES, 0x41);
    expect((await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: first.toString("base64"),
      now: later(2),
    })).attachment.revision).toBe(4);
    expect((await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      chunkOrdinal: 1,
      base64: Buffer.from([0x42]).toString("base64"),
      now: later(3),
    })).attachment.revision).toBe(6);
    expect(vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 6,
      chunkOrdinal: 48,
      base64: Buffer.from([0]).toString("base64"),
      now: later(4),
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

test("reconciliation commits only a fully written prepared chunk", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultreconcile1";
    const uploadId = "upload_vaultreconcile1";
    const bytes = Buffer.from("crash-cut", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "cut.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: bytes.length,
      now: NOW,
    });
    database.transaction(() => {
      database.query(`
        INSERT INTO chat_attachment_upload_chunks (
          attachment_id, upload_id, pane_id, ordinal, request_revision,
          byte_offset, byte_length, sha256, state, created_at
        ) VALUES (?1, ?2, ?3, 0, 2, 0, ?4, ?5, 'prepared', ?6)
      `).run(attachmentId, uploadId, PANE, bytes.length, sha256(bytes), later(1).toISOString());
      database.query(`
        UPDATE chat_attachments
        SET prepared_chunk_ordinal = 0, prepared_offset = 0,
            prepared_byte_length = ?2, prepared_sha256 = ?3,
            revision = 3, updated_at = ?4
        WHERE attachment_id = ?1
      `).run(attachmentId, bytes.length, sha256(bytes), later(1).toISOString());
    })();
    const source = join(root, "objects", attachmentId, "source.upload");
    await writeFile(source, bytes, { mode: 0o600 });
    await chmod(source, 0o600);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(2))).toMatchObject({ resumedChunks: 1 });
    expect(database.query(`
      SELECT revision, received_input_bytes, next_chunk_ordinal,
        prepared_chunk_ordinal
      FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({
      revision: 4,
      received_input_bytes: bytes.length,
      next_chunk_ordinal: 1,
      prepared_chunk_ordinal: null,
    });
  });
});

test("reconciliation rolls back a prepared chunk with no filesystem write", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultrollback01";
    const uploadId = "upload_vaultrollback01";
    const bytes = Buffer.from("retry-after-reopen", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "retry.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: bytes.length,
      now: NOW,
    });
    database.transaction(() => {
      database.query(`
        INSERT INTO chat_attachment_upload_chunks (
          attachment_id, upload_id, pane_id, ordinal, request_revision,
          byte_offset, byte_length, sha256, state, created_at
        ) VALUES (?1, ?2, ?3, 0, 2, 0, ?4, ?5, 'prepared', ?6)
      `).run(attachmentId, uploadId, PANE, bytes.length, sha256(bytes), later(1).toISOString());
      database.query(`
        UPDATE chat_attachments
        SET prepared_chunk_ordinal = 0, prepared_offset = 0,
            prepared_byte_length = ?2, prepared_sha256 = ?3,
            revision = 3, updated_at = ?4
        WHERE attachment_id = ?1
      `).run(attachmentId, bytes.length, sha256(bytes), later(1).toISOString());
    })();
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(2))).toMatchObject({
      resumedChunks: 0,
      rolledBackChunks: 1,
      contained: 0,
    });
    expect(database.query(`
      SELECT revision, received_input_bytes, prepared_chunk_ordinal
      FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({
      revision: 4,
      received_input_bytes: 0,
      prepared_chunk_ordinal: null,
    });
    expect(database.query(`
      SELECT state, settled_revision FROM chat_attachment_upload_chunks
      WHERE attachment_id = ?1 AND ordinal = 0 AND request_revision = 2
    `).get(attachmentId)).toEqual({ state: "rolled_back", settled_revision: 4 });
    expect(reopened.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(3),
    })).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await reopened.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(4),
    })).attachment.revision).toBe(6);
  });
});

test("reconciliation completes the generic hard-link publication crash cut", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaulthardlink01";
    const uploadId = "upload_vaulthardlink01";
    const bytes = Buffer.from("published-once", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "once.txt",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
    });
    await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(1),
    });
    database.query(`
      UPDATE chat_attachments
      SET state = 'publishing', finalize_request_revision = 4,
          requested_input_sha256 = ?2, input_sha256 = ?2,
          revision = 5, updated_at = ?3
      WHERE attachment_id = ?1
    `).run(attachmentId, sha256(bytes), later(2).toISOString());
    const object = join(root, "objects", attachmentId);
    const source = join(object, "source.upload");
    const published = join(object, "blob.txt");
    await link(source, published);
    expect((await stat(source)).nlink).toBe(2);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(3))).toMatchObject({
      published: 1,
      contained: 0,
    });
    expect(database.query(`
      SELECT state, revision FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready", revision: 6 });
    expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(published)).nlink).toBe(1);
  });
});

test("ready image reconciliation verifies and removes a retained source crash cut", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultimagesource1";
    const uploadId = "upload_vaultimagesource1";
    const sourceBytes = Buffer.from("metadata-bearing-image-source", "utf8");
    await uploadReady(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes: sourceBytes,
      displayName: "source.png",
      mediaType: "image/png",
    });
    const source = join(root, "objects", attachmentId, "source.upload");
    expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(source, sourceBytes, { mode: 0o600 });
    database.query(`
      UPDATE chat_attachments
      SET source_retained = 1, revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(attachmentId, later(10).toISOString());

    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(11))).toMatchObject({ contained: 0 });
    expect(database.query(`
      SELECT source_retained FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ source_retained: 0 });
    expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("ready source cleanup refuses a hard link introduced after digest verification", async () => {
  const entered = deferredVoid();
  const resume = deferredVoid();
  let armed = false;
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultsourcerace1";
    const uploadId = "upload_vaultsourcerace1";
    const sourceBytes = Buffer.from("source identity race", "utf8");
    await uploadReady(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes: sourceBytes,
      displayName: "source.png",
      mediaType: "image/png",
    });
    const source = join(root, "objects", attachmentId, "source.upload");
    await writeFile(source, sourceBytes, { mode: 0o600 });
    database.query(`
      UPDATE chat_attachments
      SET source_retained = 1, revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(attachmentId, later(10).toISOString());
    armed = true;
    const pending = vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(sourceBytes),
      now: later(11),
    });
    await entered.promise;
    const external = join(root, "external-source-race-copy");
    await link(source, external);
    resume.resolve();
    expect(await rejectionOf(pending)).toMatchObject({ code: "corrupt" });
    expect((await stat(source)).nlink).toBe(2);
    expect(database.query(`
      SELECT state, source_retained FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt", source_retained: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 1 });
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_aftersourcerace",
      uploadId: "upload_aftersourcerace",
      kind: "file",
      displayName: "blocked.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(12),
    }))).toMatchObject({ code: "unsafe_filesystem" });
    await unlink(external);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    await reopened.deletePanePrivateData({
      paneId: PANE,
      now: later(13),
      authorizationReceipt: "source-race-privacy-authorization",
      containmentReceipt: "source-race-provider-containment",
    });
    expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  }, new FixtureNormalizer(), async (checkpoint) => {
    if (!armed || checkpoint !== "source-verified") return;
    entered.resolve();
    await resume.promise;
  });
});

test("normalizer failure removes bounded helper residue before admitting more bytes", async () => {
  const residueName = `.hra-image-normalizer-${"a".repeat(32)}.tmp`;
  await withVault(async ({ vault, root, database }) => {
    const attachmentId = "attachment_vaultresidue01";
    const uploadId = "upload_vaultresidue01";
    const source = Buffer.from("source", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes: source,
      displayName: "timeout.png",
      mediaType: "image/png",
    });
    expect(vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(source),
      now: later(2),
    })).rejects.toMatchObject({ code: "corrupt" });
    const residue = join(root, "objects", attachmentId, residueName);
    expect(stat(residue)).rejects.toMatchObject({ code: "ENOENT" });
    expect(database.query(`
      SELECT state, provider_bytes FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt", provider_bytes: null });
    expect((await vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterresidue1",
      uploadId: "upload_afterresidue1",
      kind: "file",
      displayName: "next.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 24 * 1024 * 1024,
      now: later(3),
    })).attachment.state).toBe("uploading");
  }, new ResidueFailingNormalizer(residueName));
});

test("normalizer failure after final generation publication removes undocumented bytes", async () => {
  await withVault(async ({ vault, root, database }) => {
    const attachmentId = "attachment_vaultfinalcrash1";
    const source = Buffer.from("source", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId: "upload_vaultfinalcrash1",
      kind: "image",
      bytes: source,
      displayName: "crash.png",
      mediaType: "image/png",
    });
    expect(vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId: "upload_vaultfinalcrash1",
      expectedRevision: 4,
      inputSha256: sha256(source),
      now: later(2),
    })).rejects.toMatchObject({ code: "corrupt" });
    expect(stat(join(root, "objects", attachmentId, "normalized"))).rejects
      .toMatchObject({ code: "ENOENT" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 0 });
    expect((await vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterfinalcrash",
      uploadId: "upload_afterfinalcrash",
      kind: "file",
      displayName: "accepted.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(3),
    })).attachment.state).toBe("uploading");
  }, new FinalGenerationFailingNormalizer());
});

test("startup quarantines a crash-left hard-linked helper generation", async () => {
  const residueName = `.hra-image-normalizer-${"c".repeat(32)}.tmp`;
  await withVault(async ({ vault, root, database, normalizer }) => {
    const attachmentId = "attachment_vaultreconhardtmp";
    const source = Buffer.from("source", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId: "upload_vaultreconhardtmp",
      kind: "image",
      bytes: source,
      displayName: "resume.png",
      mediaType: "image/png",
    });
    database.query(`
      UPDATE chat_attachments
      SET state = 'normalizing', finalize_request_revision = 4,
          requested_input_sha256 = ?2, input_sha256 = ?2, revision = 5
      WHERE attachment_id = ?1
    `).run(attachmentId, sha256(source));
    const residue = join(root, "objects", attachmentId, residueName);
    await mkdir(residue, { mode: 0o700 });
    const canonical = join(residue, "canonical.png");
    await writeFile(canonical, Buffer.from("crash residue", "utf8"), { mode: 0o600 });
    const external = join(root, "external-reconcile-temp-copy");
    await link(canonical, external);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(3))).toMatchObject({ contained: 1 });
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 1 });
    expect(reopened.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterreconhard1",
      uploadId: "upload_afterreconhard1",
      kind: "file",
      displayName: "blocked.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(4),
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    await unlink(external);
  });
});

test("corrupt custody never adopts kind-impossible filesystem entries", async () => {
  for (const kind of ["image", "file"] as const) {
    await withVault(async ({ vault, root, database, normalizer }) => {
      const attachmentId = `attachment_vaultwrongkind${kind}`;
      const uploadId = `upload_vaultwrongkind${kind}`;
      await uploadReceiving(vault, {
        attachmentId,
        uploadId,
        kind,
        bytes: Buffer.from(kind, "utf8"),
        displayName: kind === "image" ? "wrong.png" : "wrong.txt",
        mediaType: kind === "image" ? "image/png" : "text/plain",
      });
      database.query(`
        UPDATE chat_attachments
        SET state = 'corrupt', revision = revision + 1, updated_at = ?2
        WHERE attachment_id = ?1
      `).run(attachmentId, later(2).toISOString());
      const object = join(root, "objects", attachmentId);
      const impossible = kind === "image"
        ? join(object, "blob.png")
        : join(object, "normalized");
      if (kind === "image") {
        await writeFile(impossible, Buffer.from("unowned blob", "utf8"), { mode: 0o600 });
      } else {
        await mkdir(impossible, { mode: 0o700 });
        await writeFile(
          join(impossible, "canonical.png"),
          Buffer.from("unowned canonical", "utf8"),
          { mode: 0o600 },
        );
        await writeFile(
          join(impossible, "preview.png"),
          Buffer.from("unowned preview", "utf8"),
          { mode: 0o600 },
        );
      }
      const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
      expect(await rejectionOf(reopened.reconcile(later(3)))).toMatchObject({
        code: "unsafe_filesystem",
      });
      expect(await rejectionOf(reopened.deletePanePrivateData({
        paneId: PANE,
        now: later(4),
        authorizationReceipt: `wrong-kind-${kind}-authorization`,
        containmentReceipt: `wrong-kind-${kind}-provider-containment`,
      }))).toMatchObject({ code: "unsafe_filesystem" });
      const preserved = await stat(impossible);
      expect(kind === "image" ? preserved.isFile() : preserved.isDirectory()).toBe(true);
    });
  }
});

test("privacy deletion refuses helper residue with an external hard link", async () => {
  const residueName = `.hra-image-normalizer-${"b".repeat(32)}.tmp`;
  const normalizer = new HardLinkedResidueFailingNormalizer(residueName);
  await withVault(async ({ vault, root, database }) => {
    const attachmentId = "attachment_vaulthardtemp001";
    const uploadId = "upload_vaulthardtemp001";
    const source = Buffer.from("source", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes: source,
      displayName: "temp.png",
      mediaType: "image/png",
    });
    const alreadyAdmittedId = "attachment_vaultbeforequar1";
    const alreadyAdmittedBytes = Buffer.from("already admitted", "utf8");
    await uploadReceiving(vault, {
      attachmentId: alreadyAdmittedId,
      uploadId: "upload_vaultbeforequar1",
      kind: "image",
      bytes: alreadyAdmittedBytes,
      displayName: "before.png",
      mediaType: "image/png",
    });
    expect(vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(source),
      now: later(2),
    })).rejects.toMatchObject({ code: "corrupt" });
    const residue = join(
      root,
      "objects",
      attachmentId,
      residueName,
      "canonical.png",
    );
    const external = join(root, "external-temp-copy");
    expect((await stat(residue)).nlink).toBe(2);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 1 });
    expect(vault.finalizeUpload({
      paneId: PANE,
      attachmentId: alreadyAdmittedId,
      uploadId: "upload_vaultbeforequar1",
      expectedRevision: 4,
      inputSha256: sha256(alreadyAdmittedBytes),
      now: later(3),
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(normalizer.calls).toBe(1);
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(alreadyAdmittedId)).toEqual({ state: "receiving" });
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterhardtemp1",
      uploadId: "upload_afterhardtemp1",
      kind: "file",
      displayName: "blocked.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(4),
    }))).toMatchObject({ code: "unsafe_filesystem" });
    expect(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(5),
      authorizationReceipt: "temp-hardlink-privacy-authorization",
      containmentReceipt: "temp-hardlink-provider-containment",
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "privacy" });
    await unlink(external);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    await reopened.reconcile(later(6));
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  }, normalizer);
});

test("ready inventory contains an unexpected sibling and preserves it for explicit cleanup", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_vaultinventory1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaultinventory1",
      kind: "file",
      bytes: Buffer.from("inventory", "utf8"),
      displayName: "inventory.txt",
      mediaType: "text/plain",
    });
    const unexpected = join(root, "objects", attachmentId, "unexpected.bin");
    await writeFile(unexpected, Buffer.from("unowned", "utf8"), { mode: 0o600 });
    expect(await vault.reconcile(later(20))).toMatchObject({ contained: 1 });
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt" });
    expect(await readFile(unexpected, "utf8")).toBe("unowned");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 1 });
    expect(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterinventory1",
      uploadId: "upload_afterinventory1",
      kind: "file",
      displayName: "blocked.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(21),
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(22),
      authorizationReceipt: "explicit-inventory-privacy-cleanup",
      containmentReceipt: "explicit-inventory-provider-containment",
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(await readFile(unexpected, "utf8")).toBe("unowned");
  });
});

test("generic custody never adopts an image-normalizer temporary generation", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_vaultgenerictemp1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaultgenerictemp1",
      kind: "file",
      bytes: Buffer.from("generic", "utf8"),
      displayName: "generic.txt",
      mediaType: "text/plain",
    });
    const residue = join(
      root,
      "objects",
      attachmentId,
      `.hra-image-normalizer-${"d".repeat(32)}.tmp`,
    );
    await mkdir(residue, { mode: 0o700 });
    await writeFile(
      join(residue, "canonical.png"),
      Buffer.from("unowned image residue", "utf8"),
      { mode: 0o600 },
    );
    expect(await vault.reconcile(later(20))).toMatchObject({ contained: 1 });
    expect((await stat(residue)).isDirectory()).toBe(true);
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 1 });
    expect(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_aftergenerictemp",
      uploadId: "upload_aftergenerictemp",
      kind: "file",
      displayName: "blocked.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(21),
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
  });
});

test("ready finalization replay contains changed provider bytes", async () => {
  for (const kind of ["image", "file"] as const) {
    await withVault(async ({ vault, database, root }) => {
      const attachmentId = `attachment_vaultreadytamper${kind}`;
      const uploadId = `upload_vaultreadytamper${kind}`;
      const source = Buffer.from(`ready-${kind}`, "utf8");
      await uploadReady(vault, {
        attachmentId,
        uploadId,
        kind,
        bytes: source,
        displayName: kind === "image" ? "ready.png" : "ready.txt",
        mediaType: kind === "image" ? "image/png" : "text/plain",
      });
      const provider = kind === "image"
        ? join(root, "objects", attachmentId, "normalized", "canonical.png")
        : join(root, "objects", attachmentId, "blob.txt");
      const original = await readFile(provider);
      await writeFile(provider, Buffer.alloc(original.byteLength, 0x78), { mode: 0o600 });
      expect(await rejectionOf(vault.finalizeUpload({
        paneId: PANE,
        attachmentId,
        uploadId,
        expectedRevision: 4,
        inputSha256: sha256(source),
        now: later(3),
      }))).toMatchObject({ code: "corrupt" });
      expect(database.query(`
        SELECT state FROM chat_attachments WHERE attachment_id = ?1
      `).get(attachmentId)).toEqual({ state: "corrupt" });
    });
  }
});

test("reconciliation rejects an object directory without a durable SQL owner", async () => {
  await withVault(async ({ vault, root }) => {
    const orphan = join(root, "objects", "attachment_orphaninventory1");
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(join(orphan, "source.upload"), Buffer.from([1]), { mode: 0o600 });
    expect(vault.reconcile(later(1))).rejects.toMatchObject({
      code: "unsafe_filesystem",
    });
    expect((await stat(orphan)).isDirectory()).toBe(true);
  });
});

test("symlink substitution is contained before bytes can become ready", async () => {
  await withVault(async ({ vault, root, database }) => {
    const attachmentId = "attachment_vaultsymlink01";
    const uploadId = "upload_vaultsymlink01";
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "unsafe.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: NOW,
    });
    const outside = join(root, "outside");
    await writeFile(outside, Buffer.from([1]), { mode: 0o600 });
    const source = join(root, "objects", attachmentId, "source.upload");
    await unlink(source);
    await symlink(outside, source);
    expect(vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: Buffer.from([1]).toString("base64"),
      now: later(1),
    })).rejects.toBeInstanceOf(ChatAttachmentVaultError);
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt" });
  });
});

test("corrupt reconciliation permits a missing object directory and an empty generic object", async () => {
  await withVault(async ({ vault, root, database }) => {
    const missingId = "attachment_vaultmissingobj1";
    await vault.beginUpload({
      paneId: PANE,
      attachmentId: missingId,
      uploadId: "upload_vaultmissingobj1",
      kind: "file",
      displayName: "missing.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: NOW,
    });
    await rm(join(root, "objects", missingId), { recursive: true });
    expect(vault.appendChunk({
      paneId: PANE,
      attachmentId: missingId,
      uploadId: "upload_vaultmissingobj1",
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: Buffer.from([1]).toString("base64"),
      now: later(1),
    })).rejects.toBeInstanceOf(ChatAttachmentVaultError);

    const emptyId = "attachment_vaultemptyobj01";
    await vault.beginUpload({
      paneId: PANE,
      attachmentId: emptyId,
      uploadId: "upload_vaultemptyobj01",
      kind: "file",
      displayName: "empty.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(2),
    });
    await unlink(join(root, "objects", emptyId, "source.upload"));
    expect(vault.appendChunk({
      paneId: PANE,
      attachmentId: emptyId,
      uploadId: "upload_vaultemptyobj01",
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: Buffer.from([1]).toString("base64"),
      now: later(3),
    })).rejects.toBeInstanceOf(ChatAttachmentVaultError);
    expect(await vault.reconcile(later(4))).toMatchObject({ contained: 0 });
    expect(database.query(`
      SELECT attachment_id, state FROM chat_attachments
      WHERE attachment_id IN (?1, ?2) ORDER BY attachment_id
    `).all(missingId, emptyId)).toEqual([
      { attachment_id: emptyId, state: "corrupt" },
      { attachment_id: missingId, state: "corrupt" },
    ]);
  });
});

test("image previews are relationship checked and digest mismatch is contained", async () => {
  await withVault(async ({ vault, root, database }) => {
    const attachmentId = "attachment_vaultimage001";
    const uploadId = "upload_vaultimage001";
    const sourceBytes = Buffer.from("fake-image-source", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "image",
      displayName: "pasted.png",
      declaredMediaType: "image/png",
      expectedBytes: sourceBytes.length,
      now: NOW,
    });
    await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: sourceBytes.toString("base64"),
      now: later(1),
    });
    const ready = await vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(sourceBytes),
      now: later(2),
    });
    const preview = await vault.readPreview({
      paneId: PANE,
      attachmentId,
      expectedRevision: ready.attachment.revision,
      relationship: { kind: "draft" },
      now: later(3),
    });
    expect(Buffer.from(preview.bytes)).toEqual(Buffer.from("preview", "utf8"));
    const previewPath = join(root, "objects", attachmentId, "normalized", "preview.png");
    await writeFile(previewPath, Buffer.from("PREVIEW", "utf8"), { mode: 0o600 });
    expect(vault.readPreview({
      paneId: PANE,
      attachmentId,
      expectedRevision: ready.attachment.revision,
      relationship: { kind: "draft" },
      now: later(4),
    })).rejects.toMatchObject({ code: "corrupt" });
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt" });
  });
});

test("discarded ambiguous message authority cannot read or retain a preview", async () => {
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultdiscarded1";
    const ready = await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaultdiscarded1",
      kind: "image",
      bytes: Buffer.from("discarded image source", "utf8"),
      displayName: "discarded.png",
      mediaType: "image/png",
    });
    const turnId = "chatturn_vaultdiscarded1";
    const messageId = "chatmsg_vaultdiscarded1";
    database.transaction(() => {
      database.query(`
        INSERT INTO chat_message_ledger (
          message_id, pane_id, ordinal, revision, message_text,
          message_utf8_bytes, state, claimed_turn_id,
          effect_started_at, acknowledged_at, terminal_at,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, 1, 1, 'unknown delivery', 16, 'ambiguous', ?3,
          ?4, NULL, ?5, ?4, ?5
        )
      `).run(messageId, PANE, turnId, later(4).toISOString(), later(8).toISOString());
      database.query(`
        INSERT INTO chat_message_attachment_refs (
          message_id, pane_id, position, attachment_id,
          consumed_draft_expires_at
        ) VALUES (?1, ?2, 0, ?3, ?4)
      `).run(messageId, PANE, attachmentId, later(4).toISOString());
      database.query(`
        DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
      `).run(attachmentId);
      database.query(`
        INSERT INTO chat_attachment_turn_leases (
          attachment_id, pane_id, message_id, turn_id, state,
          acquired_at, updated_at, released_at
        ) VALUES (?1, ?2, ?3, ?4, 'released', ?5, ?6, ?6)
      `).run(
        attachmentId,
        PANE,
        messageId,
        turnId,
        later(5).toISOString(),
        later(8).toISOString(),
      );
      database.query(`
        UPDATE chat_panes
        SET active_turn_id = ?2, turn_status = 'completed',
            turn_started_at = ?3, turn_completed_at = ?4,
            revision = revision + 1, updated_at = ?4
        WHERE pane_id = ?1
      `).run(PANE, turnId, later(3).toISOString(), later(8).toISOString());
      database.query(`
        INSERT INTO chat_message_ambiguous_resolutions (
          message_id, pane_id, claimed_turn_id, resolution, resolved_at
        ) VALUES (?1, ?2, ?3, 'discarded', ?4)
      `).run(messageId, PANE, turnId, later(9).toISOString());
    })();
    expect(vault.readPreview({
      paneId: PANE,
      attachmentId,
      expectedRevision: ready.attachment.revision,
      relationship: { kind: "message", messageId },
      now: later(10),
    })).rejects.toMatchObject({ code: "not_found" });
    await vault.reconcile(later(11));
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
      WHERE message_id = ?1 AND attachment_id = ?2
    `).get(messageId, attachmentId)).toEqual({ count: 0 });
    expect(await vault.collectGarbage({
      now: later(7_211),
      graceMs: 1_000,
    })).toEqual({ deleted: 1, contained: 0 });
  });
});

test("privacy deletion releases provider custody and purges pane bytes and receipts", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_vaultprivacy01";
    const uploadId = "upload_vaultprivacy01";
    const bytes = Buffer.from("private", "utf8");
    const begun = await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "private.txt",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
    });
    await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: begun.attachment.revision,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(1),
    });
    await vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(bytes),
      now: later(2),
    });
    vault.acquireProviderLease({
      bindingId: "attbinding_vaultprivacy01",
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentIds: [attachmentId],
      now: later(3),
    });
    expect(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "authorization-is-not-containment",
      containmentReceipt: "authorization-is-not-containment",
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(database.query(`
      SELECT state FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "active" });
    await vault.deletePanePrivateData({
      paneId: PANE,
      now: later(5),
      authorizationReceipt: "authorized-delete-all-private-pane-data",
      containmentReceipt: "all-private-pane-provider-bindings-contained",
    });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_attachment_bindings
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_deletion_receipts
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterprivacy001",
      uploadId: "upload_afterprivacy001",
      kind: "file",
      displayName: "after.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(6),
    })).rejects.toMatchObject({ code: "invalid_state" });
    expect(stat(join(root, "objects", attachmentId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test("privacy tombstone atomically consumes account-contained archive identity", async () => {
  for (const [index, purpose] of ([
    "start_fresh",
    "pane_archive",
  ] as const).entries()) {
    await withVault(async ({ vault, database }) => {
      const suffix = String(index + 1).padStart(2, "0");
      const containmentReceipt = `privacy_account_containment_receipt_${suffix}`;
      database.query(`
        INSERT INTO chat_provider_thread_archive_intents (
          pane_id, purpose, state, pane_revision, queue_revision,
          account_profile_id, thread_id, restart_thread_id,
          generation, generation_contained, generation_containment_receipt,
          effect_attempt, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'account_contained', 1, ?3,
          ?4, ?5, ?6,
          1, 1, ?7,
          0, ?8, ?8
        )
      `).run(
        PANE,
        purpose,
        purpose === "start_fresh" ? 1 : null,
        ACCOUNT,
        `thread_privacy_contained_${suffix}`,
        `raw_thread_privacy_contained_${suffix}`,
        containmentReceipt,
        NOW.toISOString(),
      );

      expect(await rejectionOf(vault.deletePanePrivateData({
        paneId: PANE,
        now: NOW,
        authorizationReceipt: `privacy_delete_authorization_wrong_${suffix}`,
        containmentReceipt: `wrong_privacy_containment_receipt_${suffix}`,
      }))).toMatchObject({ code: "conflict" });
      expect(database.query(`
        SELECT purpose, state FROM chat_provider_thread_archive_intents
        WHERE pane_id = ?1
      `).get(PANE)).toEqual({ purpose, state: "account_contained" });

      await vault.deletePanePrivateData({
        paneId: PANE,
        now: later(1),
        authorizationReceipt: `privacy_delete_authorization_exact_${suffix}`,
        containmentReceipt,
      });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
        WHERE pane_id = ?1
      `).get(PANE)).toEqual({ count: 0 });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
        WHERE pane_id = ?1
      `).get(PANE)).toEqual({ count: 0 });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
        WHERE pane_id = ?1
      `).get(PANE)).toEqual({ count: 1 });
    });
  }
});

test("privacy deletion rejects provider archive authority before and during finalization", async () => {
  await withVault(async ({ vault, database }) => {
    insertPreparedProviderArchiveIntent(database);
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: NOW,
      authorizationReceipt: "preexisting-v56-privacy-authorization",
      containmentReceipt: "preexisting-v56-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    database.query(`
      INSERT INTO chat_attachment_privacy_tombstones (pane_id, completed_at)
      VALUES (?1, ?2)
    `).run(PANE, NOW.toISOString());
    insertPreparedProviderArchiveIntent(database);
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: NOW,
      authorizationReceipt: "tombstone-v56-privacy-authorization",
      containmentReceipt: "tombstone-v56-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });

  let checkpointDatabase: Database | null = null;
  let injected = false;
  await withVault(async ({ vault, database }) => {
    checkpointDatabase = database;
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: NOW,
      authorizationReceipt: "racing-v56-privacy-authorization",
      containmentReceipt: "racing-v56-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "privacy-bytes-removed" || injected) {
      return Promise.resolve();
    }
    if (checkpointDatabase === null) throw new Error("Expected checkpoint database");
    injected = true;
    insertPreparedProviderArchiveIntent(checkpointDatabase);
    return Promise.resolve();
  });
});

test("privacy deletion rejects v57 archive authority before tombstone and finalization", async () => {
  await withVault(async ({ vault, database }) => {
    insertEffectStartedProviderArchiveTargetV57(database, "preexisting01");
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(2),
      authorizationReceipt: "preexisting-v57-privacy-authorization",
      containmentReceipt: "preexisting-v57-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    database.query(`
      INSERT INTO chat_attachment_privacy_tombstones (pane_id, completed_at)
      VALUES (?1, ?2)
    `).run(PANE, NOW.toISOString());
    insertEffectStartedProviderArchiveTargetV57(database, "tombstone01");
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(2),
      authorizationReceipt: "tombstone-v57-privacy-authorization",
      containmentReceipt: "tombstone-v57-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });

  await withVault(async ({ vault, database }) => {
    insertPendingProviderArchiveMemberV57(database);
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(6),
      authorizationReceipt: "member-v57-privacy-authorization",
      containmentReceipt: "member-v57-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_cut_members_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  let checkpointDatabase: Database | null = null;
  let injected = false;
  await withVault(async ({ vault, database }) => {
    checkpointDatabase = database;
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(2),
      authorizationReceipt: "racing-v57-privacy-authorization",
      containmentReceipt: "racing-v57-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "privacy-bytes-removed" || injected) {
      return Promise.resolve();
    }
    if (checkpointDatabase === null) throw new Error("Expected checkpoint database");
    injected = true;
    insertEffectStartedProviderArchiveTargetV57(
      checkpointDatabase,
      "finalization01",
    );
    return Promise.resolve();
  });
});

test("privacy deletion fences unsealed v57 source siblings by exact generation and account", async () => {
  await withVault(async ({ vault, database }) => {
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "source01",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      cause: "lost_response",
      suffix: "source01",
      fenced: true,
    });

    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "source-sibling-v57-privacy-authorization",
      containmentReceipt: "source-sibling-v57-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state FROM chat_provider_thread_archive_cuts_v57
      WHERE account_profile_id = ?1
    `).get(ACCOUNT)).toEqual({ state: "fenced" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_cut_members_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    database.query(`
      UPDATE account_profiles
      SET process_generation = 2, revision = revision + 1, updated_at = ?2
      WHERE profile_id = ?1
    `).run(ACCOUNT, later(1).toISOString());
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "generation02",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 2,
      cause: "lost_response",
      suffix: "generation02",
    });

    await vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "other-generation-v57-privacy-authorization",
      containmentReceipt: "other-generation-v57-privacy-containment",
    });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });

  await withVault(async ({ vault, database }) => {
    const otherAccount = "acct_vaultprivacycutother";
    insertArchiveFixtureAccount(database, otherAccount, 1);
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "account03",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: otherAccount,
      sourceGeneration: 1,
      cause: "lost_response",
      suffix: "account03",
    });

    await vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "other-account-v57-privacy-authorization",
      containmentReceipt: "other-account-v57-privacy-containment",
    });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });

  await withVault(async ({ vault, database }) => {
    database.query(`
      UPDATE account_profiles
      SET process_generation = 2, revision = revision + 1, updated_at = ?2
      WHERE profile_id = ?1
    `).run(ACCOUNT, later(1).toISOString());
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "removal04",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 2,
      cause: "account_removal",
      suffix: "removal04",
    });

    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "account-removal-v57-privacy-authorization",
      containmentReceipt: "account-removal-v57-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });
});

test("attachment writes preserve v57 target, member, and source-cut quarantine", async () => {
  await withVault(async ({ vault, database }) => {
    insertEffectStartedProviderArchiveTargetV57(database, "write_target01");
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57writetarget01",
      uploadId: "upload_v57writetarget01",
      kind: "file",
      displayName: "blocked.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(2),
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    insertPendingProviderArchiveMemberV57(database);
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57writemember1",
      uploadId: "upload_v57writemember1",
      kind: "file",
      displayName: "blocked.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(6),
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "write_source01",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      cause: "lost_response",
      suffix: "write_source01",
      fenced: true,
    });
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57writesource1",
      uploadId: "upload_v57writesource1",
      kind: "file",
      displayName: "blocked.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(4),
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    database.query(`
      UPDATE account_profiles
      SET process_generation = 2, revision = revision + 1, updated_at = ?2
      WHERE profile_id = ?1
    `).run(ACCOUNT, later(1).toISOString());
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "write_generation02",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 2,
      cause: "lost_response",
      suffix: "write_generation02",
    });
    expect((await vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57writeothergen",
      uploadId: "upload_v57writeothergen",
      kind: "file",
      displayName: "allowed.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(4),
    })).attachment.state).toBe("uploading");
  });

  await withVault(async ({ vault, database }) => {
    const otherAccount = "acct_v57writeotheraccount";
    insertArchiveFixtureAccount(database, otherAccount, 1);
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "write_account03",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: otherAccount,
      sourceGeneration: 1,
      cause: "lost_response",
      suffix: "write_account03",
    });
    expect((await vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57writeotheracct",
      uploadId: "upload_v57writeotheracct",
      kind: "file",
      displayName: "allowed.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(4),
    })).attachment.state).toBe("uploading");
  });
});

test("a v57 target appearing after attachment I/O prevents post-cut mutation", async () => {
  let checkpointDatabase: Database | null = null;
  let injected = false;
  await withVault(async ({ vault, database }) => {
    checkpointDatabase = database;
    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57writerace01",
      uploadId: "upload_v57writerace01",
      kind: "file",
      displayName: "race.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: NOW,
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state, revision FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "creating", revision: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "begin-created" || injected) return Promise.resolve();
    if (checkpointDatabase === null) throw new Error("Expected checkpoint database");
    injected = true;
    insertEffectStartedProviderArchiveTargetV57(
      checkpointDatabase,
      "write_race01",
    );
    return Promise.resolve();
  });
});

test("terminal attachment-reference GC preserves every live v57 quarantine shape", async () => {
  for (const [suffix, establishAuthority] of [
    ["target01", (database: Database) => {
      insertEffectStartedProviderArchiveTargetV57(database, "gc_target01");
    }],
    ["pending01", (database: Database) => {
      insertPendingProviderArchiveMemberV57(database);
    }],
    ["settled01", (database: Database) => {
      insertPendingProviderArchiveMemberV57(database, "settled");
    }],
    ["source01", (database: Database) => {
      bindFixturePaneToProviderGenerationV57(database, {
        paneId: PANE,
        accountProfileId: ACCOUNT,
        generation: 1,
        suffix: "gc_source01",
      });
      insertUnsealedProviderArchiveCutV57(database, {
        accountProfileId: ACCOUNT,
        sourceGeneration: 1,
        cause: "lost_response",
        suffix: "gc_source01",
        fenced: true,
      });
    }],
  ] as const) {
    await withVault(async ({ vault, database }) => {
      const custody = await insertTerminalGcAttachmentReference(
        vault,
        database,
        suffix,
      );
      establishAuthority(database);
      expect(await vault.collectGarbage({
        now: later(7_200),
        graceMs: 1_000,
      })).toEqual({ deleted: 0, contained: 0 });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_message_attachment_refs
        WHERE message_id = ?1 AND attachment_id = ?2
      `).get(custody.messageId, custody.attachmentId)).toEqual({ count: 1 });
      expect(database.query(`
        SELECT state FROM chat_attachments WHERE attachment_id = ?1
      `).get(custody.attachmentId)).toEqual({ state: "ready" });
    });
  }

  await withVault(async ({ vault, database }) => {
    const custody = await insertTerminalGcAttachmentReference(
      vault,
      database,
      "generation02",
    );
    database.query(`
      UPDATE account_profiles
      SET process_generation = 2, revision = revision + 1, updated_at = ?2
      WHERE profile_id = ?1
    `).run(ACCOUNT, later(3).toISOString());
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "gc_generation02",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 2,
      cause: "lost_response",
      suffix: "gc_generation02",
    });
    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
    })).toEqual({ deleted: 1, contained: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
      WHERE message_id = ?1 AND attachment_id = ?2
    `).get(custody.messageId, custody.attachmentId)).toEqual({ count: 0 });
  });
});

test("unreferenced attachment GC cannot enter a v57 target cut", async () => {
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_v57gctargetcut1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57gctargetcut1",
      kind: "file",
      bytes: Buffer.from("gc target cut", "utf8"),
      displayName: "target.txt",
      mediaType: "text/plain",
    });
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
    insertEffectStartedProviderArchiveTargetV57(database, "gc_candidate01");

    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
    })).toEqual({ deleted: 0, contained: 0 });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready", deletion_reason: null });
  });
});

test("committed start-fresh crash residue retains attachment write and GC quarantine", async () => {
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_v57committedgc1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57committedgc1",
      kind: "file",
      bytes: Buffer.from("committed target residue", "utf8"),
      displayName: "residue.txt",
      mediaType: "text/plain",
    });
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
    insertCommittedStartFreshProviderArchiveTargetV57(
      database,
      "startfresh01",
    );
    expect(database.query(`
      SELECT purpose, status FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ purpose: "start_fresh", status: "committed" });

    expect(await rejectionOf(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_v57committednew",
      uploadId: "upload_v57committednew",
      kind: "file",
      displayName: "blocked.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(4),
    }))).toMatchObject({ code: "invalid_state" });
    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
    })).toEqual({ deleted: 0, contained: 0 });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready", deletion_reason: null });
  });
});

test("reconciliation preserves every attachment crash cut owned by v57 quarantine", async () => {
  const cases = [
    ["creating", "target"],
    ["prepared", "pending_member"],
    ["normalizing", "source_cut"],
    ["publishing", "target"],
    ["ready_source", "settled_member"],
    ["corrupt", "source_cut"],
    ["deleting", "target"],
  ] as const;
  for (const [state, authority] of cases) {
    await withVault(async ({ vault, database, root, normalizer }) => {
      const fixture = await insertFrozenReconcileAttachment(
        vault,
        database,
        root,
        state,
      );
      if (authority === "target") {
        insertEffectStartedProviderArchiveTargetV57(
          database,
          `reconcile_${state}`,
        );
      } else if (authority === "pending_member") {
        insertPendingProviderArchiveMemberV57(database);
      } else if (authority === "settled_member") {
        insertPendingProviderArchiveMemberV57(database, "settled");
      } else {
        bindFixturePaneToProviderGenerationV57(database, {
          paneId: PANE,
          accountProfileId: ACCOUNT,
          generation: 1,
          suffix: `reconcile_${state}`,
        });
        insertUnsealedProviderArchiveCutV57(database, {
          accountProfileId: ACCOUNT,
          sourceGeneration: 1,
          cause: "lost_response",
          suffix: `reconcile_${state}`,
          fenced: true,
        });
      }
      const before = database.query(`
        SELECT state, revision, prepared_chunk_ordinal, source_retained,
          deletion_reason
        FROM chat_attachments WHERE attachment_id = ?1
      `).get(fixture.attachmentId);
      const reopened = new SQLiteChatAttachmentVault({
        database,
        root,
        normalizer,
      });
      expect(await reopened.reconcile(later(20))).toEqual({
        resumedChunks: 0,
        rolledBackChunks: 0,
        normalized: 0,
        published: 0,
        contained: 0,
        deleted: 0,
        residueRemoved: 0,
      });
      expect(database.query(`
        SELECT state, revision, prepared_chunk_ordinal, source_retained,
          deletion_reason
        FROM chat_attachments WHERE attachment_id = ?1
      `).get(fixture.attachmentId)).toEqual(before);
      for (const path of fixture.retainedPaths) {
        expect((await stat(path)).isFile() || (await stat(path)).isDirectory())
          .toBe(true);
      }
      for (const path of fixture.absentPaths) {
        expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
        WHERE attachment_id = ?1
      `).get(fixture.attachmentId)).toEqual({ count: 0 });
    });
  }
});

test("privacy admission fences a cutless same-generation effect only", async () => {
  await withVault(async ({ vault, database }) => {
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "cutless_same01",
    });
    insertEffectStartedProviderArchiveSiblingV57(database, {
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "cutless_same01",
    });
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(3),
      authorizationReceipt: "cutless-same-privacy-authorization",
      containmentReceipt: "cutless-same-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_deletion_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });

  await withVault(async ({ vault, database }) => {
    database.query(`
      UPDATE account_profiles
      SET process_generation = 2, revision = revision + 1, updated_at = ?2
      WHERE profile_id = ?1
    `).run(ACCOUNT, later(1).toISOString());
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "cutless_generation02",
    });
    insertEffectStartedProviderArchiveSiblingV57(database, {
      accountProfileId: ACCOUNT,
      generation: 2,
      suffix: "cutless_generation02",
    });
    await vault.deletePanePrivateData({
      paneId: PANE,
      now: later(3),
      authorizationReceipt: "cutless-generation-privacy-authorization",
      containmentReceipt: "cutless-generation-privacy-containment",
    });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });

  await withVault(async ({ vault, database }) => {
    const otherAccount = "acct_cutlessprivacyother01";
    insertArchiveFixtureAccount(database, otherAccount, 1);
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "cutless_account03",
    });
    insertEffectStartedProviderArchiveSiblingV57(database, {
      accountProfileId: otherAccount,
      generation: 1,
      suffix: "cutless_account03",
    });
    await vault.deletePanePrivateData({
      paneId: PANE,
      now: later(3),
      authorizationReceipt: "cutless-account-privacy-authorization",
      containmentReceipt: "cutless-account-privacy-containment",
    });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_privacy_tombstones WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });
});

test("garbage collection fences only the exact cutless source effect", async () => {
  const cases = [
    { suffix: "same", effectAccount: ACCOUNT, effectGeneration: 1, deleted: 0 },
    { suffix: "generation", effectAccount: ACCOUNT, effectGeneration: 2, deleted: 1 },
    {
      suffix: "account",
      effectAccount: "acct_cutlessgcother01",
      effectGeneration: 1,
      deleted: 1,
    },
  ] as const;
  for (const fixture of cases) {
    await withVault(async ({ vault, database, root }) => {
      const attachmentId = `attachment_v57cutlessgc_${fixture.suffix}`;
      await uploadReady(vault, {
        attachmentId,
        uploadId: `upload_v57cutlessgc_${fixture.suffix}`,
        kind: "file",
        bytes: Buffer.from(`cutless GC ${fixture.suffix}`, "utf8"),
        displayName: `${fixture.suffix}.txt`,
        mediaType: "text/plain",
      });
      database.query(`
        DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
      `).run(attachmentId);
      if (fixture.effectAccount !== ACCOUNT) {
        insertArchiveFixtureAccount(database, fixture.effectAccount, 1);
      } else if (fixture.effectGeneration === 2) {
        database.query(`
          UPDATE account_profiles
          SET process_generation = 2, revision = revision + 1, updated_at = ?2
          WHERE profile_id = ?1
        `).run(ACCOUNT, later(1).toISOString());
      }
      bindFixturePaneToProviderGenerationV57(database, {
        paneId: PANE,
        accountProfileId: ACCOUNT,
        generation: 1,
        suffix: `cutless_gc_${fixture.suffix}`,
      });
      insertEffectStartedProviderArchiveSiblingV57(database, {
        accountProfileId: fixture.effectAccount,
        generation: fixture.effectGeneration,
        suffix: `cutless_gc_${fixture.suffix}`,
      });
      expect(await vault.collectGarbage({
        now: later(7_200),
        graceMs: 1_000,
      })).toEqual({ deleted: fixture.deleted, contained: 0 });
      if (fixture.deleted === 0) {
        expect(database.query(`
          SELECT state, deletion_reason FROM chat_attachments
          WHERE attachment_id = ?1
        `).get(attachmentId)).toEqual({ state: "ready", deletion_reason: null });
        expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
          .toBe(true);
      } else {
        expect(database.query(`
          SELECT COUNT(*) AS count FROM chat_attachments
          WHERE attachment_id = ?1
        `).get(attachmentId)).toEqual({ count: 0 });
        expect(stat(join(root, "objects", attachmentId))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  }
});

test("privacy deletion preserves bytes in both v57 authority orderings", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_v57privacytargetfirst";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57privacytargetfirst",
      kind: "file",
      bytes: Buffer.from("target first", "utf8"),
      displayName: "target-first.txt",
      mediaType: "text/plain",
    });
    insertEffectStartedProviderArchiveTargetV57(database, "privacy_targetfirst");
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "target-first-privacy-authorization",
      containmentReceipt: "target-first-privacy-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready" });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
  });

  let checkpointDatabase: Database | null = null;
  let injected = false;
  await withVault(async ({ vault, database, root }) => {
    checkpointDatabase = database;
    const attachmentId = "attachment_v57privacyintentfirst";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57privacyintentfirst",
      kind: "file",
      bytes: Buffer.from("privacy first", "utf8"),
      displayName: "privacy-first.txt",
      mediaType: "text/plain",
    });
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "privacy-first-authorization",
      containmentReceipt: "privacy-first-containment",
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "privacy" });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "object-delete-preflight" || injected) {
      return Promise.resolve();
    }
    if (checkpointDatabase === null) throw new Error("Expected checkpoint database");
    injected = true;
    insertEffectStartedProviderArchiveTargetV57(
      checkpointDatabase,
      "privacy_intentfirst",
    );
    return Promise.resolve();
  });
});

test("garbage collection preserves bytes in both v57 authority orderings", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_v57gctargetfirst2";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57gctargetfirst2",
      kind: "file",
      bytes: Buffer.from("target first gc", "utf8"),
      displayName: "target-gc.txt",
      mediaType: "text/plain",
    });
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
    insertEffectStartedProviderArchiveTargetV57(database, "gc_targetfirst2");
    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
    })).toEqual({ deleted: 0, contained: 0 });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
  });

  let checkpointDatabase: Database | null = null;
  let injected = false;
  await withVault(async ({ vault, database, root }) => {
    checkpointDatabase = database;
    const attachmentId = "attachment_v57gcintentfirst2";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57gcintentfirst2",
      kind: "file",
      bytes: Buffer.from("gc first", "utf8"),
      displayName: "gc-first.txt",
      mediaType: "text/plain",
    });
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
    })).toEqual({ deleted: 0, contained: 0 });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "gc" });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
    expect(() => vault.assertPaneArchiveCompatible(PANE)).toThrow(
      ChatAttachmentVaultError,
    );
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "object-delete-preflight" || injected) {
      return Promise.resolve();
    }
    if (checkpointDatabase === null) throw new Error("Expected checkpoint database");
    injected = true;
    insertEffectStartedProviderArchiveTargetV57(
      checkpointDatabase,
      "gc_intentfirst2",
    );
    return Promise.resolve();
  });
});

test("durable privacy and GC cuts reject late v57 target admission before unlink", async () => {
  let privacyDatabase: Database | null = null;
  let privacyVault: SQLiteChatAttachmentVault | null = null;
  let privacyArmed = false;
  await withVault(async ({ vault, database, root }) => {
    privacyDatabase = database;
    privacyVault = vault;
    const attachmentId = "attachment_v57privacylatetarget";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57privacylatetarget",
      kind: "file",
      bytes: Buffer.from("privacy late target", "utf8"),
      displayName: "privacy-late.txt",
      mediaType: "text/plain",
    });
    seedStoreValidProviderOwnershipV57(
      database,
      vault,
      "privacy_late_target",
      0x5f,
    );
    privacyArmed = true;
    expect(await rejectionOf(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "privacy-late-target-authorization",
      containmentReceipt: "privacy-late-target-containment",
    }))).toMatchObject({ message: "fixture stopped after rejected target" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "privacy" });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "object-delete-authorized" || !privacyArmed) {
      return Promise.resolve();
    }
    const database = privacyDatabase;
    const vault = privacyVault;
    if (database === null || vault === null) {
      throw new Error("Expected privacy target-admission fixture");
    }
    expect(() => prepareProviderArchiveTargetThroughStoreV57(
      database,
      vault,
      "privacy_late_target",
    )).toThrow();
    throw new Error("fixture stopped after rejected target");
  });

  let gcDatabase: Database | null = null;
  let gcVault: SQLiteChatAttachmentVault | null = null;
  let gcArmed = false;
  await withVault(async ({ vault, database, root }) => {
    gcDatabase = database;
    gcVault = vault;
    const attachmentId = "attachment_v57gclatetarget01";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57gclatetarget01",
      kind: "file",
      bytes: Buffer.from("gc late target", "utf8"),
      displayName: "gc-late.txt",
      mediaType: "text/plain",
    });
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
    seedStoreValidProviderOwnershipV57(
      database,
      vault,
      "gc_late_target01",
      0x5f,
    );
    gcArmed = true;
    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
    })).toEqual({ deleted: 0, contained: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "gc" });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "object-delete-authorized" || !gcArmed) {
      return Promise.resolve();
    }
    const database = gcDatabase;
    const vault = gcVault;
    if (database === null || vault === null) {
      throw new Error("Expected GC target-admission fixture");
    }
    expect(() => prepareProviderArchiveTargetThroughStoreV57(
      database,
      vault,
      "gc_late_target01",
    )).toThrow();
    throw new Error("fixture stopped after rejected target");
  });
});

test("frozen v57 panes reject binding and corruption writer fallbacks", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_v57frozenwriters1";
    const bindingId = "attbinding_v57frozenwriters1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57frozenwriters1",
      kind: "file",
      bytes: Buffer.from("frozen writer", "utf8"),
      displayName: "frozen.txt",
      mediaType: "text/plain",
    });
    const binding = vault.acquireProviderLease({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentIds: [attachmentId],
      now: later(3),
    });
    bindFixturePaneToProviderGenerationV57(database, {
      paneId: PANE,
      accountProfileId: ACCOUNT,
      generation: 1,
      suffix: "frozen_writers01",
    });
    insertUnsealedProviderArchiveCutV57(database, {
      accountProfileId: ACCOUNT,
      sourceGeneration: 1,
      cause: "lost_response",
      suffix: "frozen_writers01",
      fenced: true,
    });

    expect(() => vault.markProviderBindingAmbiguous({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      expectedRevision: binding.revision,
      ambiguityReceipt: "frozen-writer-ambiguity-receipt",
      now: later(4),
    })).toThrow(ChatAttachmentVaultError);
    expect(database.query(`
      SELECT state, revision FROM chat_provider_attachment_bindings
      WHERE binding_id = ?1
    `).get(bindingId)).toEqual({ state: "active", revision: binding.revision });

    await writeFile(
      join(root, "objects", attachmentId, "blob.txt"),
      Buffer.from("changed after freeze", "utf8"),
      { mode: 0o600 },
    );
    expect(await rejectionOf(vault.providerDescriptor({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentId,
      now: later(5),
    }))).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 0 });
  });
});

test("ready-source reconciliation rechecks v57 authority before unlink", async () => {
  let checkpointDatabase: Database | null = null;
  let armed = false;
  let injected = false;
  await withVault(async ({ vault, database, root }) => {
    checkpointDatabase = database;
    const attachmentId = "attachment_v57readysourcerace1";
    const bytes = Buffer.from("ready source race", "utf8");
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57readysourcerace1",
      kind: "image",
      bytes,
      displayName: "source-race.png",
      mediaType: "image/png",
    });
    const source = join(root, "objects", attachmentId, "source.upload");
    await writeFile(source, bytes, { mode: 0o600 });
    database.query(`
      UPDATE chat_attachments
      SET source_retained = 1, revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(attachmentId, later(10).toISOString());
    armed = true;

    expect(await vault.reconcile(later(11))).toEqual({
      resumedChunks: 0,
      rolledBackChunks: 0,
      normalized: 0,
      published: 0,
      contained: 0,
      deleted: 0,
      residueRemoved: 0,
    });
    expect(database.query(`
      SELECT state, source_retained FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready", source_retained: 1 });
    expect((await stat(source)).isFile()).toBe(true);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 0 });
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "source-verified" || !armed || injected) {
      return Promise.resolve();
    }
    if (checkpointDatabase === null) throw new Error("Expected checkpoint database");
    injected = true;
    insertEffectStartedProviderArchiveTargetV57(
      checkpointDatabase,
      "ready_source_race01",
    );
    return Promise.resolve();
  });
});

test("ready-source cleanup rejects late Store target admission before unlink", async () => {
  let checkpointDatabase: Database | null = null;
  let checkpointVault: SQLiteChatAttachmentVault | null = null;
  let armed = false;
  await withVault(async ({ vault, database, root }) => {
    checkpointDatabase = database;
    checkpointVault = vault;
    seedStoreValidProviderOwnershipV57(
      database,
      vault,
      "ready_source_store_race01",
      0x5f,
    );
    const attachmentId = "attachment_v57readysourcestore1";
    armed = true;
    expect(await rejectionOf(uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57readysourcestore1",
      kind: "image",
      bytes: Buffer.from("ready source Store race", "utf8"),
      displayName: "source-store-race.png",
      mediaType: "image/png",
    }))).toMatchObject({ code: "corrupt" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT state, source_retained FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "corrupt", source_retained: 1 });
    expect((await stat(join(root, "objects", attachmentId, "source.upload")))
      .isFile()).toBe(true);
  }, new FixtureNormalizer(), (checkpoint) => {
    if (checkpoint !== "source-delete-authorized" || !armed) {
      return Promise.resolve();
    }
    const database = checkpointDatabase;
    const vault = checkpointVault;
    if (database === null || vault === null) {
      throw new Error("Expected ready-source Store target fixture");
    }
    expect(() => prepareProviderArchiveTargetThroughStoreV57(
      database,
      vault,
      "ready_source_store_race01",
    )).toThrow(ChatAttachmentVaultError);
    throw new Error("fixture stopped before source unlink");
  });
});

test("v57 target admission rejects every active attachment filesystem cut", async () => {
  const states = [
    "creating",
    "prepared",
    "normalizing",
    "publishing",
    "ready_source",
    "corrupt",
    "deleting",
  ] as const;
  for (const state of states) {
    await withVault(async ({ vault, database, root }) => {
      seedStoreValidProviderOwnershipV57(
        database,
        vault,
        `strict_${state}`,
        0x5f,
      );
      const fixture = await insertFrozenReconcileAttachment(
        vault,
        database,
        root,
        state,
      );
      const before = database.query(`
        SELECT state, revision, prepared_chunk_ordinal, source_retained,
          deletion_reason
        FROM chat_attachments WHERE attachment_id = ?1
      `).get(fixture.attachmentId);
      expect(() => prepareProviderArchiveTargetThroughStoreV57(
        database,
        vault,
        `strict_${state}`,
      )).toThrow(ChatAttachmentVaultError);
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57
        WHERE pane_id = ?1
      `).get(PANE)).toEqual({ count: 0 });
      expect(database.query(`
        SELECT state, revision, prepared_chunk_ordinal, source_retained,
          deletion_reason
        FROM chat_attachments WHERE attachment_id = ?1
      `).get(fixture.attachmentId)).toEqual(before);
      for (const path of fixture.retainedPaths) {
        expect((await stat(path)).isFile() || (await stat(path)).isDirectory())
          .toBe(true);
      }
      for (const path of fixture.absentPaths) {
        expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  }
});

test("pane archive rejects every active non-archive attachment deletion cut", async () => {
  for (const reason of ["cancelled", "removed", "gc"] as const) {
    await withVault(async ({ vault, database }) => {
      const attachmentId = `attachment_archiveconflict_${reason}`;
      await uploadReady(vault, {
        attachmentId,
        uploadId: `upload_archiveconflict_${reason}`,
        kind: "file",
        bytes: Buffer.from(reason, "utf8"),
        displayName: `${reason}.txt`,
        mediaType: "text/plain",
      });
      database.transaction(() => {
        database.query(`
          DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
        `).run(attachmentId);
        database.query(`
          UPDATE chat_attachments
          SET state = 'deleting', deletion_reason = ?2,
              revision = revision + 1, updated_at = ?3
          WHERE attachment_id = ?1
        `).run(attachmentId, reason, later(3).toISOString());
      })();
      expect(() => vault.assertPaneArchiveCompatible(PANE)).toThrow(
        ChatAttachmentVaultError,
      );
      expect(() => archivePaneInTransaction(
        vault,
        database,
        `archive-conflict-${reason}-receipt`,
        later(4),
      )).toThrow(ChatAttachmentVaultError);
      expect(database.query(`
        SELECT archived_at FROM chat_panes WHERE pane_id = ?1
      `).get(PANE)).toEqual({ archived_at: null });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM chat_attachment_pane_archive_intents
        WHERE pane_id = ?1
      `).get(PANE)).toEqual({ count: 0 });
    });
  }
});

test("committed v57 pane archive authority completes its attachment cleanup", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_v57committedarchive1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57committedarchive1",
      kind: "file",
      bytes: Buffer.from("committed archive", "utf8"),
      displayName: "archive.txt",
      mediaType: "text/plain",
    });
    seedStoreValidProviderOwnershipV57(
      database,
      vault,
      "committed_archive01",
      0x5e,
    );
    const prepared = finalizeProviderArchivePaneTargetThroughStoreV57(
      database,
      vault,
      "committed_archive01",
    );
    expect(database.query(`
      SELECT purpose, status FROM chat_provider_thread_archive_targets_v57
      WHERE target_id = ?1
    `).get(prepared.targetId)).toEqual({
      purpose: "pane_archive",
      status: "committed",
    });
    const reopened = new SQLiteChatAttachmentVault({
      database,
      root,
      normalizer,
    });
    const verifiedStore = new ChatPaneStore(database, {
      messageRequestDigestKey: new Uint8Array(operationReceiptKeyByteLength)
        .fill(0x5e),
      paneArchiveAuthority: reopened,
    });
    expect(verifiedStore.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toContain(prepared.targetId);
    reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57([
      prepared.targetId,
    ]);
    expect(() =>
      reopened.assertProviderThreadArchiveTerminalPostimagesV57([
        prepared.targetId,
      ])
    ).toThrow(ChatAttachmentVaultError);
    expect(await reopened.reconcile(later(5))).toMatchObject({ deleted: 1 });
    reopened.assertProviderThreadArchiveTerminalPostimagesV57([
      prepared.targetId,
    ]);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT reason FROM chat_attachment_deletion_receipts
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ reason: "archive" });
    expect(database.query(`
      SELECT state FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "completed" });
    expect(stat(join(root, "objects", attachmentId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test("v57 startup Vault authorization binds an exact mixed terminal snapshot", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    seedStoreValidProviderOwnershipV57(database, vault, "exact_mixed01", 0x5e);
    const archived = finalizeProviderArchivePaneTargetThroughStoreV57(
      database,
      vault,
      "exact_mixed01",
    );
    const startFreshPaneId = "pane_v57vaultterminalsf_mixed01";
    insertAdditionalPane(database, startFreshPaneId, 1);
    const startFreshTargetId = insertVaultTerminalStartFreshTargetV57(
      database,
      startFreshPaneId,
      "mixed01",
    );
    const expected = [archived.targetId, startFreshTargetId].sort();
    const reopened = new SQLiteChatAttachmentVault({
      database,
      root,
      normalizer,
    });

    expect(() =>
      reopened.assertProviderThreadArchiveTerminalPostimagesV57(expected)
    ).toThrow(ChatAttachmentVaultError);
    expect(() =>
      reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
        [archived.targetId],
      )
    ).toThrow(ChatAttachmentVaultError);
    expect(() =>
      reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
        [expected[0]!, expected[0]!],
      )
    ).toThrow(ChatAttachmentVaultError);
    expect(() =>
      reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
        [...expected].reverse(),
      )
    ).toThrow(ChatAttachmentVaultError);

    reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
      expected,
    );
    reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
      expected,
    );
    await reopened.reconcile(later(6));
    reopened.assertProviderThreadArchiveTerminalPostimagesV57(expected);
  });
});

test("v57 startup Vault accepts an exact completed privacy tombstone terminal postimage", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    seedStoreValidProviderOwnershipV57(
      database,
      vault,
      "privacy_terminal01",
      0x5e,
    );
    database.query(`
      INSERT INTO chat_attachment_privacy_tombstones (pane_id, completed_at)
      VALUES (?1, ?2)
    `).run(PANE, NOW.toISOString());
    const archived = finalizeProviderArchivePaneTargetThroughStoreV57(
      database,
      vault,
      "privacy_terminal01",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });

    const reopened = new SQLiteChatAttachmentVault({
      database,
      root,
      normalizer,
    });
    const store = new ChatPaneStore(database, {
      messageRequestDigestKey: new Uint8Array(operationReceiptKeyByteLength)
        .fill(0x5e),
      paneArchiveAuthority: reopened,
    });
    const expected = store.verifyProviderThreadArchiveTerminalAuthorityV57();
    expect(expected).toEqual([archived.targetId]);
    reopened.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(
      expected,
    );
    await reopened.reconcile(later(6));
    reopened.assertProviderThreadArchiveTerminalPostimagesV57(expected);
    expect(
      store.sweepProviderThreadArchiveTerminalAuthorityV57(expected).cleanup,
    ).toMatchObject({ deletedTargetIds: [archived.targetId] });
  });
});

test("v57 startup Vault terminal assertion rejects committed-target drift", async () => {
  await withVault(({ vault, database }) => {
    const firstTargetId = insertVaultTerminalStartFreshTargetV57(
      database,
      PANE,
      "drift_first01",
    );
    vault.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57([
      firstTargetId,
    ]);
    vault.assertProviderThreadArchiveTerminalPostimagesV57([firstTargetId]);

    const secondPaneId = "pane_v57vaultterminalsf_drift02";
    insertAdditionalPane(database, secondPaneId, 1);
    const secondTargetId = insertVaultTerminalStartFreshTargetV57(
      database,
      secondPaneId,
      "drift_second02",
    );
    expect(() =>
      vault.assertProviderThreadArchiveTerminalPostimagesV57([firstTargetId])
    ).toThrow(ChatAttachmentVaultError);
    expect(() =>
      vault.assertProviderThreadArchiveTerminalPostimagesV57(
        [firstTargetId, secondTargetId].sort(),
      )
    ).toThrow(ChatAttachmentVaultError);
  });
});

test("v57 start-fresh terminal assertion preserves ready custody and rejects unfinished custody", async () => {
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_v57terminalsf_ready01";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57terminalsf_ready01",
      kind: "image",
      bytes: Buffer.from("ready across start fresh", "utf8"),
      displayName: "ready.png",
      mediaType: "image/png",
    });
    const targetId = insertVaultTerminalStartFreshTargetV57(
      database,
      PANE,
      "custody01",
    );
    vault.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57([
      targetId,
    ]);
    vault.assertProviderThreadArchiveTerminalPostimagesV57([targetId]);
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready" });

    database.transaction(() => {
      database.query(`
        INSERT INTO chat_provider_attachment_bindings (
          binding_id, binding_key_digest, pane_id, revision, state,
          acquired_at, updated_at
        ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
      `).run(
        "attbinding_v57terminalsf01",
        KEY_DIGEST,
        PANE,
        later(4).toISOString(),
      );
      database.query(`
        INSERT INTO chat_provider_attachment_leases (
          binding_id, pane_id, attachment_id, acquired_at
        ) VALUES (?1, ?2, ?3, ?4)
      `).run(
        "attbinding_v57terminalsf01",
        PANE,
        attachmentId,
        later(4).toISOString(),
      );
    })();
    expect(() =>
      vault.assertProviderThreadArchiveTerminalPostimagesV57([targetId])
    ).toThrow(ChatAttachmentVaultError);

    database.query(`
      UPDATE chat_provider_attachment_bindings
      SET state = 'released', containment_receipt_digest = ?2,
          revision = revision + 1, updated_at = ?3, released_at = ?3
      WHERE binding_id = ?1
    `).run(
      "attbinding_v57terminalsf01",
      "c".repeat(64),
      later(5).toISOString(),
    );
    vault.assertProviderThreadArchiveTerminalPostimagesV57([targetId]);

    database.query(`
      UPDATE chat_attachments
      SET source_retained = 1, revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(attachmentId, later(6).toISOString());
    expect(() =>
      vault.assertProviderThreadArchiveTerminalPostimagesV57([targetId])
    ).toThrow(ChatAttachmentVaultError);
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "ready" });
  });
});

test("v57 empty terminal authorization is exact, idempotent, and outer-transaction composable", async () => {
  await withVault(({ vault, database }) => {
    vault.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57([]);
    vault.authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57([]);
    vault.assertProviderThreadArchiveTerminalPostimagesV57([]);
    const original = database.query(`
      SELECT title FROM chat_panes WHERE pane_id = ?1
    `).get(PANE);

    expect(() => database.transaction(() => {
      vault.assertProviderThreadArchiveTerminalPostimagesV57([]);
      database.query(`
        UPDATE chat_panes SET title = 'rolled back terminal assertion'
        WHERE pane_id = ?1
      `).run(PANE);
      throw new Error("rollback outer Vault assertion transaction");
    })()).toThrow("rollback outer Vault assertion transaction");
    expect(database.query(`
      SELECT title FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual(original);
    vault.assertProviderThreadArchiveTerminalPostimagesV57([]);
  });
});

test("startup refuses Store-foreign committed pane-archive cleanup", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_v57foreignarchive1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_v57foreignarchive1",
      kind: "file",
      bytes: Buffer.from("foreign archive", "utf8"),
      displayName: "foreign.txt",
      mediaType: "text/plain",
    });
    const prepared = insertDirectAppliedProviderArchivePaneTargetV57(
      database,
      "foreign_archive01",
    );
    archivePaneInTransaction(
      vault,
      database,
      "foreign-v57-pane-archive-containment",
      later(3),
    );
    prepared.journal.markTargetCommitted({
      targetId: prepared.targetId,
      commitEvidenceDigest: "9".repeat(64),
      commitRevisionDigest: "a".repeat(64),
      now: later(4),
    });

    const reopened = new SQLiteChatAttachmentVault({
      database,
      root,
      normalizer,
    });
    expect(await reopened.reconcile(later(5))).toEqual({
      resumedChunks: 0,
      rolledBackChunks: 0,
      normalized: 0,
      published: 0,
      contained: 0,
      deleted: 0,
      residueRemoved: 0,
    });
    expect((await stat(join(root, "objects", attachmentId, "blob.txt"))).isFile())
      .toBe(true);
    expect(database.query(`
      SELECT state FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "pane_archived" });
    const foreignStore = new ChatPaneStore(database, {
      messageRequestDigestKey: new Uint8Array(operationReceiptKeyByteLength)
        .fill(0x5d),
      paneArchiveAuthority: reopened,
    });
    expect(() => foreignStore.verifyProviderThreadArchiveTerminalAuthorityV57())
      .toThrow();
  });
});

test("startup finishes privacy metadata purge after bytes were already deleted", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultprivacycut1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaultprivacycut1",
      kind: "file",
      bytes: Buffer.from("privacy cut", "utf8"),
      displayName: "cut.txt",
      mediaType: "text/plain",
    });
    vault.acquireProviderLease({
      bindingId: "attbinding_vaultprivacycut1",
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentIds: [attachmentId],
      now: later(3),
    });
    database.query(`
      INSERT INTO chat_attachment_deletion_receipts (
        attachment_id, upload_id, pane_id, final_revision, reason, deleted_at
      ) VALUES (
        'attachment_vaultpriortomb1', 'upload_vaultpriortomb1', ?1,
        1, 'removed', ?2
      )
    `).run(PANE, later(3).toISOString());
    database.exec(`
      CREATE TRIGGER fixture_privacy_metadata_crash
      BEFORE DELETE ON chat_provider_attachment_bindings
      BEGIN
        SELECT RAISE(ABORT, 'fixture privacy metadata crash');
      END;
    `);
    expect(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(4),
      authorizationReceipt: "privacy-cut-authorization",
      containmentReceipt: "privacy-cut-provider-containment",
    })).rejects.toThrow("fixture privacy metadata crash");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect(stat(join(root, "objects", attachmentId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    database.exec("DROP TRIGGER fixture_privacy_metadata_crash");
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(5))).toMatchObject({ contained: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_attachment_bindings WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_deletion_receipts WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  });
});

test("privacy completion fences an upload queued while bytes are being purged", async () => {
  const entered = deferredVoid();
  const resume = deferredVoid();
  await withVault(async ({ vault, database }) => {
    await uploadReady(vault, {
      attachmentId: "attachment_vaultprivacyqueue",
      uploadId: "upload_vaultprivacyqueue",
      kind: "file",
      bytes: Buffer.from("private", "utf8"),
      displayName: "private.txt",
      mediaType: "text/plain",
    });
    const deleting = vault.deletePanePrivateData({
      paneId: PANE,
      now: later(3),
      authorizationReceipt: "queued-privacy-authorization",
      containmentReceipt: "queued-privacy-provider-containment",
    });
    await entered.promise;
    const queued = vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_vaultafterqueue1",
      uploadId: "upload_vaultafterqueue1",
      kind: "file",
      displayName: "after.txt",
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: later(4),
    });
    resume.resolve();
    await deleting;
    expect(await rejectionOf(queued)).toMatchObject({ code: "invalid_state" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_tombstones
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
  }, new FixtureNormalizer(), async (checkpoint) => {
    if (checkpoint !== "privacy-bytes-removed") return;
    entered.resolve();
    await resume.promise;
  });
});

test("privacy deletion refuses an externally hard-linked generic payload", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaulthardprivacy1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaulthardprivacy1",
      kind: "file",
      bytes: Buffer.from("hard-linked privacy", "utf8"),
      displayName: "private.txt",
      mediaType: "text/plain",
    });
    const blob = join(root, "objects", attachmentId, "blob.txt");
    const external = join(root, "external-generic-copy");
    await link(blob, external);
    expect(vault.deletePanePrivateData({
      paneId: PANE,
      now: later(3),
      authorizationReceipt: "hardlink-privacy-authorization",
      containmentReceipt: "hardlink-privacy-provider-containment",
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "privacy" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_privacy_deletion_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 1 });
    expect((await stat(blob)).nlink).toBe(2);
    await unlink(external);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    await reopened.reconcile(later(4));
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  });
});

test("archive deletion reason survives a crash after bytes disappear", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultarchive01";
    const uploadId = "upload_vaultarchive01";
    const bytes = Buffer.from("archive", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "archive.txt",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
    });
    await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(1),
    });
    await vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(bytes),
      now: later(2),
    });
    database.exec(`
      CREATE TRIGGER fixture_archive_receipt_crash
      BEFORE INSERT ON chat_attachment_deletion_receipts
      WHEN NEW.reason = 'archive'
      BEGIN
        SELECT RAISE(ABORT, 'fixture crash after byte deletion');
      END;
    `);
    archivePaneInTransaction(
      vault,
      database,
      "archive-provider-resume-contained",
      later(3),
    );
    expect(vault.archivePaneAfterResumeContained({
      paneId: PANE,
      now: later(3),
      containmentReceipt: "archive-provider-resume-contained",
    })).rejects.toThrow("fixture crash");
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "archive" });
    expect(stat(join(root, "objects", attachmentId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    database.exec("DROP TRIGGER fixture_archive_receipt_crash");
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(4))).toMatchObject({ deleted: 1 });
    expect(database.query(`
      SELECT reason FROM chat_attachment_deletion_receipts
      WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ reason: "archive" });
  });
});

test("startup joins an archived pane intent before purging every owned object", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaultarchiveref1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaultarchiveref1",
      kind: "file",
      bytes: Buffer.from("archived reference", "utf8"),
      displayName: "reference.txt",
      mediaType: "text/plain",
    });
    const store = new ChatPaneStore(database);
    store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_vaultarchiveref1",
      content: { text: "archive with attachment", attachmentRefs: [attachmentId] },
      now: later(2),
    });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
      WHERE pane_id = ?1 AND attachment_id = ?2
    `).get(PANE, attachmentId)).toEqual({ count: 1 });
    archivePaneInTransaction(
      vault,
      database,
      "archive-all-resume-authority-contained",
      later(3),
    );
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    expect(await reopened.reconcile(later(4))).toMatchObject({ deleted: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect(stat(join(root, "objects", attachmentId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(database.query(`
      SELECT state FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "completed" });
  });
});

test("a failed pane archive transaction rolls back its prepared attachment intent", async () => {
  await withVault(async ({ vault, database, root }) => {
    const attachmentId = "attachment_vaultarchiveroll1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaultarchiveroll1",
      kind: "file",
      bytes: Buffer.from("still live", "utf8"),
      displayName: "live.txt",
      mediaType: "text/plain",
    });
    const input = {
      paneId: PANE,
      containmentReceipt: "rolled-back-pane-archive-containment",
      now: later(3),
    } as const;
    expect(() => database.transaction(() => {
      vault.preparePaneArchiveInTransaction(input);
      database.query(`
        UPDATE chat_panes
        SET workspace_state = 'preserved', workspace_recovery_reason = NULL,
            workspace_revision = workspace_revision + 1,
            archived_at = ?2, revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1
      `).run(PANE, input.now.toISOString());
      throw new Error("fixture pane archive rollback");
    })()).toThrow("fixture pane archive rollback");
    expect(database.query(`
      SELECT archived_at FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({ archived_at: null });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_pane_archive_intents
      WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect((await stat(join(root, "objects", attachmentId))).isDirectory()).toBe(true);
  });
});

test("pane archive refuses an externally hard-linked normalized image", async () => {
  await withVault(async ({ vault, database, root, normalizer }) => {
    const attachmentId = "attachment_vaulthardarchive1";
    await uploadReady(vault, {
      attachmentId,
      uploadId: "upload_vaulthardarchive1",
      kind: "image",
      bytes: Buffer.from("image source", "utf8"),
      displayName: "image.png",
      mediaType: "image/png",
    });
    const canonical = join(root, "objects", attachmentId, "normalized", "canonical.png");
    const external = join(root, "external-image-copy");
    await link(canonical, external);
    archivePaneInTransaction(
      vault,
      database,
      "hardlink-archive-provider-contained",
      later(3),
    );
    expect(vault.archivePaneAfterResumeContained({
      paneId: PANE,
      now: later(3),
      containmentReceipt: "hardlink-archive-provider-contained",
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(database.query(`
      SELECT state, deletion_reason FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({ state: "deleting", deletion_reason: "archive" });
    expect(database.query(`
      SELECT state FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "pane_archived" });
    expect((await stat(canonical)).nlink).toBe(2);
    await unlink(external);
    const reopened = new SQLiteChatAttachmentVault({ database, root, normalizer });
    await reopened.reconcile(later(4));
    expect(database.query(`
      SELECT state FROM chat_attachment_pane_archive_intents WHERE pane_id = ?1
    `).get(PANE)).toEqual({ state: "completed" });
  });
});

test("active provider custody blocks GC until resume is explicitly contained", async () => {
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultgclease01";
    const uploadId = "upload_vaultgclease01";
    const bindingId = "attbinding_vaultgclease01";
    const bytes = Buffer.from("retained", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "retained.txt",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
      draftLeaseMs: 1_000,
    });
    await vault.appendChunk({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 2,
      chunkOrdinal: 0,
      base64: bytes.toString("base64"),
      now: later(1),
    });
    await vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(bytes),
      now: later(2),
    });
    vault.acquireProviderLease({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      attachmentIds: [attachmentId],
      now: later(3),
    });
    expect(await vault.collectGarbage({
      now: later(7_203),
      graceMs: 1_000,
    })).toEqual({ deleted: 0, contained: 0 });
    vault.releaseProviderBindingAfterResumeContained({
      bindingId,
      bindingKeyDigest: KEY_DIGEST,
      paneId: PANE,
      expectedRevision: 1,
      containmentReceipt: "gc-old-provider-binding-contained",
      now: later(7_204),
    });
    expect(await vault.collectGarbage({
      now: later(7_205),
      graceMs: 1_000,
    })).toEqual({ deleted: 1, contained: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments
    `).get()).toEqual({ count: 0 });
  });
});

test("expired incomplete drafts become GC-visible and release their reserved quota", async () => {
  await withVault(async ({ vault, database }) => {
    const maximum = 24 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      await vault.beginUpload({
        paneId: PANE,
        attachmentId: `attachment_expireddraft${String(index).padStart(3, "0")}`,
        uploadId: `upload_expireddraft${String(index).padStart(3, "0")}`,
        kind: "file",
        displayName: `abandoned-${index}.bin`,
        declaredMediaType: "application/octet-stream",
        expectedBytes: maximum,
        now: NOW,
        draftLeaseMs: 1_000,
      });
    }
    expect(vault.projectPane({
      paneId: PANE,
      referencedAttachmentIds: [],
      now: later(7_200),
    }).drafts).toEqual([]);
    expect(await vault.collectGarbage({
      now: later(7_200),
      graceMs: 1_000,
      maximumDeletes: 16,
    })).toEqual({ deleted: 5, contained: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
    expect((await vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_afterdraftgc1",
      uploadId: "upload_afterdraftgc1",
      kind: "file",
      displayName: "accepted.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: maximum,
      now: later(7_201),
    })).attachment.state).toBe("uploading");
  });
});

test("pane and global byte reservations are enforced before filesystem creation", async () => {
  await withVault(async ({ vault, database }) => {
    const maximum = 24 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      await vault.beginUpload({
        paneId: PANE,
        attachmentId: `attachment_panequota${String(index).padStart(3, "0")}`,
        uploadId: `upload_panequota${String(index).padStart(3, "0")}`,
        kind: "file",
        displayName: `pane-${index}.bin`,
        declaredMediaType: "application/octet-stream",
        expectedBytes: maximum,
        now: later(index),
      });
    }
    expect(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_panequota999",
      uploadId: "upload_panequota999",
      kind: "file",
      displayName: "overflow.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: maximum,
      now: later(6),
    })).rejects.toMatchObject({ code: "quota_exceeded" });

    // Replace the first pane's reservations with four full 120 MiB panes.
    await vault.deletePanePrivateData({
      paneId: PANE,
      now: later(7),
      authorizationReceipt: "quota-fixture-first-pane-contained",
      containmentReceipt: "quota-fixture-provider-bindings-contained",
    });
    const quotaPanes = [
      "pane_globalquota001",
      "pane_globalquota002",
      "pane_globalquota003",
      "pane_globalquota004",
      "pane_globalquota005",
    ];
    quotaPanes.forEach((paneId, index) => {
      insertAdditionalPane(database, paneId, index + 1);
    });
    for (const [paneIndex, paneId] of quotaPanes.slice(0, 4).entries()) {
      for (let item = 0; item < 5; item += 1) {
        insertReceivingReservation(
          database,
          paneId,
          `attachment_global${paneIndex}${item}000000`,
          `upload_global${paneIndex}${item}000000`,
          maximum,
          later(10 + paneIndex * 5 + item),
        );
      }
    }
    await vault.beginUpload({
      paneId: quotaPanes[4]!,
      attachmentId: "attachment_globalaccepted1",
      uploadId: "upload_globalaccepted1",
      kind: "file",
      displayName: "accepted.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: maximum,
      now: later(40),
    });
    expect(vault.beginUpload({
      paneId: quotaPanes[4]!,
      attachmentId: "attachment_globaloverflow1",
      uploadId: "upload_globaloverflow1",
      kind: "file",
      displayName: "overflow.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: maximum,
      now: later(41),
    })).rejects.toMatchObject({ code: "quota_exceeded" });
  });
});

test("a failed hard-link deletion remains charged to pane quota", async () => {
  await withVault(async ({ vault, database, root }) => {
    const maximum = 24 * 1024 * 1024;
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const attachmentId = `attachment_deletequota${String(index).padStart(3, "0")}`;
      ids.push(attachmentId);
      await vault.beginUpload({
        paneId: PANE,
        attachmentId,
        uploadId: `upload_deletequota${String(index).padStart(3, "0")}`,
        kind: "file",
        displayName: `${index}.bin`,
        declaredMediaType: "application/octet-stream",
        expectedBytes: maximum,
        now: later(index),
      });
    }
    const first = ids[0]!;
    database.query(`
      UPDATE chat_attachments
      SET state = 'corrupt', revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(first, later(5).toISOString());
    const source = join(root, "objects", first, "source.upload");
    const external = join(root, "external-delete-quota-copy");
    await link(source, external);
    expect(vault.removeAttachment({
      paneId: PANE,
      attachmentId: first,
      expectedRevision: 3,
      now: later(6),
    })).rejects.toMatchObject({ code: "unsafe_filesystem" });
    expect(database.query(`
      SELECT state FROM chat_attachments WHERE attachment_id = ?1
    `).get(first)).toEqual({ state: "deleting" });
    expect(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_deletequota999",
      uploadId: "upload_deletequota999",
      kind: "file",
      displayName: "must-not-fit.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 9 * 1024 * 1024,
      now: later(7),
    })).rejects.toMatchObject({ code: "quota_exceeded" });
    await unlink(external);
  });
});

test("image finalization counts canonical, preview, and retained source at the exact pane limit", async () => {
  const canonicalBytes = 17;
  const previewBytes = CHAT_ATTACHMENT_PREVIEW_MAX_BYTES;
  const source = Buffer.from([0x42]);
  const ownedAtPublication = source.length + canonicalBytes + previewBytes;
  const normalizer = new SizedFixtureNormalizer(canonicalBytes, previewBytes);
  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultexactquota1";
    const uploadId = "upload_vaultexactquota1";
    await uploadReceiving(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes: source,
      displayName: "exact.png",
      mediaType: "image/png",
    });
    insertReceivingReservationsTotal(
      database,
      PANE,
      CHAT_ATTACHMENT_MAX_PANE_READY_BYTES - ownedAtPublication,
      "exact",
    );
    expect((await vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(source),
      now: later(100),
    })).attachment.state).toBe("ready");
  }, normalizer);

  await withVault(async ({ vault, database }) => {
    const attachmentId = "attachment_vaultoverquota1";
    const uploadId = "upload_vaultoverquota1";
    await uploadReceiving(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes: source,
      displayName: "overflow.png",
      mediaType: "image/png",
    });
    insertReceivingReservationsTotal(
      database,
      PANE,
      CHAT_ATTACHMENT_MAX_PANE_READY_BYTES - ownedAtPublication + 1,
      "over",
    );
    expect(vault.finalizeUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      expectedRevision: 4,
      inputSha256: sha256(source),
      now: later(100),
    })).rejects.toMatchObject({ code: "corrupt" });
    expect(database.query(`
      SELECT state, provider_bytes, preview_bytes, source_retained
      FROM chat_attachments WHERE attachment_id = ?1
    `).get(attachmentId)).toEqual({
      state: "corrupt",
      provider_bytes: canonicalBytes,
      preview_bytes: previewBytes,
      source_retained: 1,
    });
    expect(vault.beginUpload({
      paneId: PANE,
      attachmentId: "attachment_vaultafterquota1",
      uploadId: "upload_vaultafterquota1",
      kind: "file",
      displayName: "must-not-fit.bin",
      declaredMediaType: "application/octet-stream",
      expectedBytes: 1,
      now: later(101),
    })).rejects.toMatchObject({ code: "quota_exceeded" });
  }, normalizer);
});

test("the legal hydration maximum is 256 referenced attachments plus 8 drafts", async () => {
  await withVault(({ vault, database }) => {
    const referenced: string[] = [];
    for (let index = 0; index < 264; index += 1) {
      const attachmentId = `attachment_projection${String(index).padStart(4, "0")}`;
      insertReadyMetadataOnly(
        database,
        PANE,
        attachmentId,
        `upload_projection${String(index).padStart(4, "0")}`,
        later(index),
      );
      if (index < 8) {
        database.query(`
          INSERT INTO chat_attachment_draft_leases (
            attachment_id, pane_id, expires_at, created_at
          ) VALUES (?1, ?2, ?3, ?4)
        `).run(attachmentId, PANE, later(10_000).toISOString(), later(index).toISOString());
      } else {
        referenced.push(attachmentId);
      }
    }
    const projected = vault.projectPane({
      paneId: PANE,
      referencedAttachmentIds: referenced,
      now: later(9_000),
    });
    expect(projected.drafts).toHaveLength(8);
    expect(projected.referenced).toHaveLength(256);
  });
});

interface VaultFixture {
  readonly vault: SQLiteChatAttachmentVault;
  readonly database: Database;
  readonly root: string;
  readonly normalizer: ChatImageNormalizer;
}

async function withVault(
  run: (fixture: VaultFixture) => Promise<void> | void,
  normalizer: ChatImageNormalizer = new FixtureNormalizer(),
  afterIoCheckpoint?: ConstructorParameters<
    typeof SQLiteChatAttachmentVault
  >[0]["afterIoCheckpoint"],
): Promise<void> {
  const root = await mkdtemp("/private/tmp/hra-attachment-vault-test-");
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    insertFixturePane(database);
    const vault = new SQLiteChatAttachmentVault({
      database,
      root,
      normalizer,
      ...(afterIoCheckpoint === undefined ? {} : { afterIoCheckpoint }),
    });
    await run({ vault, database, root, normalizer });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function uploadReceiving(
  vault: SQLiteChatAttachmentVault,
  input: Readonly<{
    attachmentId: string;
    uploadId: string;
    kind: "image" | "file";
    bytes: Uint8Array;
    displayName: string;
    mediaType: string;
  }>,
): Promise<void> {
  await vault.beginUpload({
    paneId: PANE,
    attachmentId: input.attachmentId,
    uploadId: input.uploadId,
    kind: input.kind,
    displayName: input.displayName,
    declaredMediaType: input.mediaType,
    expectedBytes: input.bytes.byteLength,
    now: NOW,
  });
  await vault.appendChunk({
    paneId: PANE,
    attachmentId: input.attachmentId,
    uploadId: input.uploadId,
    expectedRevision: 2,
    chunkOrdinal: 0,
    base64: Buffer.from(input.bytes).toString("base64"),
    now: later(1),
  });
}

async function uploadReady(
  vault: SQLiteChatAttachmentVault,
  input: Readonly<{
    attachmentId: string;
    uploadId: string;
    kind: "image" | "file";
    bytes: Uint8Array;
    displayName: string;
    mediaType: string;
  }>,
) {
  await uploadReceiving(vault, input);
  return await vault.finalizeUpload({
    paneId: PANE,
    attachmentId: input.attachmentId,
    uploadId: input.uploadId,
    expectedRevision: 4,
    inputSha256: sha256(input.bytes),
    now: later(2),
  });
}

async function insertTerminalGcAttachmentReference(
  vault: SQLiteChatAttachmentVault,
  database: Database,
  suffix: string,
): Promise<Readonly<{ attachmentId: string; messageId: string }>> {
  const attachmentId = `attachment_v57gc_${suffix}`;
  const messageId = `chatmsg_v57gc_${suffix}`;
  await uploadReady(vault, {
    attachmentId,
    uploadId: `upload_v57gc_${suffix}`,
    kind: "file",
    bytes: Buffer.from(`gc-${suffix}`, "utf8"),
    displayName: `${suffix}.txt`,
    mediaType: "text/plain",
  });
  database.transaction(() => {
    database.query(`
      INSERT INTO chat_message_ledger (
        message_id, pane_id, ordinal, revision, message_text,
        message_utf8_bytes, state, claimed_turn_id,
        effect_started_at, acknowledged_at, terminal_at,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, 1, 1, 'gc', 2, 'cancelled', NULL,
        NULL, NULL, ?3, ?3, ?3
      )
    `).run(messageId, PANE, later(3).toISOString());
    database.query(`
      INSERT INTO chat_message_attachment_refs (
        message_id, pane_id, position, attachment_id,
        consumed_draft_expires_at
      ) VALUES (?1, ?2, 0, ?3, ?4)
    `).run(messageId, PANE, attachmentId, later(3).toISOString());
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
  })();
  return { attachmentId, messageId };
}

async function insertFrozenReconcileAttachment(
  vault: SQLiteChatAttachmentVault,
  database: Database,
  root: string,
  state:
    | "creating"
    | "prepared"
    | "normalizing"
    | "publishing"
    | "ready_source"
    | "corrupt"
    | "deleting",
): Promise<Readonly<{
  attachmentId: string;
  retainedPaths: readonly string[];
  absentPaths: readonly string[];
}>> {
  const attachmentId = `attachment_v57reconcile_${state}`;
  const uploadId = `upload_v57reconcile_${state}`;
  const objectPath = join(root, "objects", attachmentId);
  const sourcePath = join(objectPath, "source.upload");
  if (state === "creating") {
    database.transaction(() => {
      database.query(`
        INSERT INTO chat_attachments (
          attachment_id, upload_id, pane_id, revision, state, kind,
          display_name, declared_media_type, effective_media_type,
          internal_suffix, expected_input_bytes, received_input_bytes,
          source_retained, next_chunk_ordinal, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 1, 'creating', 'file',
          'creating.txt', 'text/plain', NULL,
          'txt', 1, 0, 1, 0, ?4, ?4
        )
      `).run(attachmentId, uploadId, PANE, NOW.toISOString());
      database.query(`
        INSERT INTO chat_attachment_draft_leases (
          attachment_id, pane_id, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4)
      `).run(
        attachmentId,
        PANE,
        later(7_200).toISOString(),
        NOW.toISOString(),
      );
    })();
    await mkdir(objectPath, { mode: 0o700 });
    await writeFile(sourcePath, new Uint8Array(), { mode: 0o600 });
    return { attachmentId, retainedPaths: [sourcePath], absentPaths: [] };
  }
  if (state === "corrupt") {
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: `${state}.txt`,
      declaredMediaType: "text/plain",
      expectedBytes: 1,
      now: NOW,
    });
    database.query(`
      UPDATE chat_attachments
      SET state = ?2, revision = ?3, updated_at = ?4
      WHERE attachment_id = ?1
    `).run(
      attachmentId,
      state,
      3,
      later(2).toISOString(),
    );
    return { attachmentId, retainedPaths: [sourcePath], absentPaths: [] };
  }
  if (state === "prepared") {
    const bytes = Buffer.from("prepared", "utf8");
    await vault.beginUpload({
      paneId: PANE,
      attachmentId,
      uploadId,
      kind: "file",
      displayName: "prepared.txt",
      declaredMediaType: "text/plain",
      expectedBytes: bytes.length,
      now: NOW,
    });
    database.transaction(() => {
      database.query(`
        INSERT INTO chat_attachment_upload_chunks (
          attachment_id, upload_id, pane_id, ordinal, request_revision,
          byte_offset, byte_length, sha256, state, created_at
        ) VALUES (?1, ?2, ?3, 0, 2, 0, ?4, ?5, 'prepared', ?6)
      `).run(
        attachmentId,
        uploadId,
        PANE,
        bytes.length,
        sha256(bytes),
        later(1).toISOString(),
      );
      database.query(`
        UPDATE chat_attachments
        SET prepared_chunk_ordinal = 0, prepared_offset = 0,
            prepared_byte_length = ?2, prepared_sha256 = ?3,
            revision = 3, updated_at = ?4
        WHERE attachment_id = ?1
      `).run(
        attachmentId,
        bytes.length,
        sha256(bytes),
        later(1).toISOString(),
      );
    })();
    return { attachmentId, retainedPaths: [sourcePath], absentPaths: [] };
  }
  if (state === "normalizing") {
    const bytes = Buffer.from("normalizing", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes,
      displayName: "normalizing.png",
      mediaType: "image/png",
    });
    database.query(`
      UPDATE chat_attachments
      SET state = 'normalizing', finalize_request_revision = 4,
          requested_input_sha256 = ?2, input_sha256 = ?2,
          revision = 5, updated_at = ?3
      WHERE attachment_id = ?1
    `).run(attachmentId, sha256(bytes), later(2).toISOString());
    const residue = join(
      objectPath,
      `.hra-image-normalizer-${"e".repeat(32)}.tmp`,
    );
    await mkdir(residue, { mode: 0o700 });
    const residueFile = join(residue, "canonical.png");
    await writeFile(residueFile, Buffer.from("frozen residue", "utf8"), {
      mode: 0o600,
    });
    return {
      attachmentId,
      retainedPaths: [sourcePath, residueFile],
      absentPaths: [],
    };
  }
  if (state === "publishing") {
    const bytes = Buffer.from("publishing", "utf8");
    await uploadReceiving(vault, {
      attachmentId,
      uploadId,
      kind: "file",
      bytes,
      displayName: "publishing.txt",
      mediaType: "text/plain",
    });
    database.query(`
      UPDATE chat_attachments
      SET state = 'publishing', finalize_request_revision = 4,
          requested_input_sha256 = ?2, input_sha256 = ?2,
          revision = 5, updated_at = ?3
      WHERE attachment_id = ?1
    `).run(attachmentId, sha256(bytes), later(2).toISOString());
    return {
      attachmentId,
      retainedPaths: [sourcePath],
      absentPaths: [join(objectPath, "blob.txt")],
    };
  }
  if (state === "ready_source") {
    const bytes = Buffer.from("ready source", "utf8");
    await uploadReady(vault, {
      attachmentId,
      uploadId,
      kind: "image",
      bytes,
      displayName: "ready-source.png",
      mediaType: "image/png",
    });
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    database.query(`
      UPDATE chat_attachments
      SET source_retained = 1, revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(attachmentId, later(10).toISOString());
    return { attachmentId, retainedPaths: [sourcePath], absentPaths: [] };
  }
  const bytes = Buffer.from("deleting", "utf8");
  await uploadReady(vault, {
    attachmentId,
    uploadId,
    kind: "file",
    bytes,
    displayName: "deleting.txt",
    mediaType: "text/plain",
  });
  database.transaction(() => {
    database.query(`
      DELETE FROM chat_attachment_draft_leases WHERE attachment_id = ?1
    `).run(attachmentId);
    database.query(`
      UPDATE chat_attachments
      SET state = 'deleting', deletion_reason = 'gc',
          revision = revision + 1, updated_at = ?2
      WHERE attachment_id = ?1
    `).run(attachmentId, later(10).toISOString());
  })();
  return {
    attachmentId,
    retainedPaths: [join(objectPath, "blob.txt")],
    absentPaths: [],
  };
}

function archivePaneInTransaction(
  vault: SQLiteChatAttachmentVault,
  database: Database,
  containmentReceipt: string,
  now: Date,
): void {
  const input = {
    paneId: PANE,
    containmentReceipt,
    now,
  } as const;
  database.transaction(() => {
    vault.preparePaneArchiveInTransaction(input);
    const archived = database.query(`
      UPDATE chat_panes
      SET workspace_state = 'preserved', workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1,
          archived_at = ?2, revision = revision + 1, updated_at = ?2
      WHERE pane_id = ?1 AND archived_at IS NULL
    `).run(PANE, now.toISOString());
    if (archived.changes !== 1) throw new Error("fixture pane archive failed");
    vault.markPaneArchivedInTransaction(input);
  })();
}

function insertFixturePane(database: Database): void {
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Attachment', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, NOW.toISOString());
  new ChatPaneStore(database).create({
    paneId: PANE,
    repository: {
      id: `repo_${"A".repeat(26)}`,
      name: "Attachment fixture",
      workingDirectory: "/fixture/attachment-vault",
    },
    accountProfileId: ACCOUNT,
    title: "Attachment fixture",
    now: NOW,
  });
}

function insertPreparedProviderArchiveIntent(database: Database): void {
  database.query(`
    INSERT INTO chat_provider_thread_archive_intents (
      pane_id, purpose, state, pane_revision, queue_revision,
      account_profile_id, thread_id, restart_thread_id,
      generation, generation_contained, effect_attempt, created_at, updated_at
    ) VALUES (
      ?1, 'pane_archive', 'prepared', 1, NULL,
      ?2, 'thread_vault_privacy_pending', 'raw_thread_vault_privacy_pending',
      1, 0, 0, ?3, ?3
    )
  `).run(PANE, ACCOUNT, NOW.toISOString());
}

function insertEffectStartedProviderArchiveTargetV57(
  database: Database,
  suffix: string,
): void {
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = ?2,
      provider_thread_id = ?3,
      provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(
    PANE,
    ACCOUNT,
    `thread_v57_privacy_${suffix}`,
    `restart_v57_privacy_${suffix}`,
  );
  const profile = database.query<{
    revision: number;
  }, [string]>(`
    SELECT revision FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null) throw new Error("v57 privacy fixture account disappeared");
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x57),
  );
  const targetId = `archtarget_vaultprivacy_${suffix}`;
  const attemptId = `archattempt_vaultprivacy_${suffix}`;
  journal.prepareTarget({
    targetId,
    paneId: PANE,
    purpose: "pane_archive",
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: null,
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    threadId: `thread_v57_privacy_${suffix}`,
    restartThreadId: `restart_v57_privacy_${suffix}`,
    binding: { kind: "none" },
    attempt: {
      attemptId,
      generation: 1,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "2".repeat(64),
      requestRevisionDigest: "3".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId,
    effectEvidenceDigest: "4".repeat(64),
    effectRevisionDigest: "5".repeat(64),
    now: later(1),
  });
}

function insertEffectStartedProviderArchiveSiblingV57(
  database: Database,
  input: Readonly<{
    accountProfileId: string;
    generation: number;
    suffix: string;
  }>,
): void {
  const paneId = `pane_v57cutlesseffect_${input.suffix}`;
  const threadId = `thread_v57cutlesseffect_${input.suffix}`;
  const restartThreadId = `restart_v57cutlesseffect_${input.suffix}`;
  insertAdditionalPane(database, paneId, 1);
  database.query(`
    UPDATE chat_panes SET
      account_profile_id = ?2,
      provider_account_profile_id = ?2,
      provider_thread_id = ?3,
      provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(
    paneId,
    input.accountProfileId,
    threadId,
    restartThreadId,
  );
  const profile = database.query<{
    revision: number;
  }, [string]>(`
    SELECT revision FROM account_profiles WHERE profile_id = ?1
  `).get(input.accountProfileId);
  if (profile === null) {
    throw new Error("cutless v57 effect fixture account disappeared");
  }
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x5b),
  );
  const targetId = `archtarget_v57cutlesseffect_${input.suffix}`;
  const attemptId = `archattempt_v57cutlesseffect_${input.suffix}`;
  journal.prepareTarget({
    targetId,
    paneId,
    purpose: "pane_archive",
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: null,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: profile.revision,
    threadId,
    restartThreadId,
    binding: { kind: "none" },
    attempt: {
      attemptId,
      generation: input.generation,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "2".repeat(64),
      requestRevisionDigest: "3".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId,
    effectEvidenceDigest: "4".repeat(64),
    effectRevisionDigest: "5".repeat(64),
    now: later(1),
  });
}

function insertDirectAppliedProviderArchivePaneTargetV57(
  database: Database,
  suffix: string,
): Readonly<{
  journal: ProviderThreadArchiveJournalV57;
  targetId: string;
}> {
  const threadId = `thread_v57paneapplied_${suffix}`;
  const restartThreadId = `restart_v57paneapplied_${suffix}`;
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = ?2,
      provider_thread_id = ?3,
      provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(PANE, ACCOUNT, threadId, restartThreadId);
  const profile = database.query<{
    revision: number;
    process_generation: number;
  }, [string]>(`
    SELECT revision, process_generation
    FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null) {
    throw new Error("pane-applied v57 fixture account disappeared");
  }
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x5c),
  );
  const targetId = `archtarget_v57paneapplied_${suffix}`;
  const attemptId = `archattempt_v57paneapplied_${suffix}`;
  journal.prepareTarget({
    targetId,
    paneId: PANE,
    purpose: "pane_archive",
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: null,
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    threadId,
    restartThreadId,
    binding: { kind: "none" },
    attempt: {
      attemptId,
      generation: profile.process_generation,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "2".repeat(64),
      requestRevisionDigest: "3".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId,
    effectEvidenceDigest: "4".repeat(64),
    effectRevisionDigest: "5".repeat(64),
    now: later(1),
  });
  journal.recordDirectApplied({
    attemptId,
    responseGeneration: profile.process_generation,
    responseStreamPosition: 0,
    outcomeEvidenceDigest: "6".repeat(64),
    outcomeRevisionDigest: "7".repeat(64),
    now: later(2),
  });
  return { journal, targetId };
}

function seedStoreValidProviderOwnershipV57(
  database: Database,
  vault: SQLiteChatAttachmentVault,
  suffix: string,
  receiptKeyByte: number,
): void {
  const store = new ChatPaneStore(database, {
    messageRequestDigestKey: new Uint8Array(operationReceiptKeyByteLength)
      .fill(receiptKeyByte),
    paneArchiveAuthority: vault,
  });
  const pane = store.require(PANE).projection;
  const turnId = `chatturn_v57vaultstore_${suffix}`;
  store.beginTurn({
    paneId: PANE,
    expectedRevision: pane.revision,
    turnId,
    prompt: `v57 vault ownership ${suffix}`,
    now: NOW,
  });
  store.reserveAccount(PANE, turnId, ACCOUNT, NOW);
  const routing = new RootTurnRoutingSQLiteAuthorityV1(database);
  const classified = routing.readTurnRouting(PANE, turnId);
  if (classified === null) {
    throw new Error("Expected Store-valid v57 routing classification");
  }
  routing.resolve({
    paneId: PANE,
    chatTurnId: turnId,
    selectedProfile: classified.requestedProfile,
    profileFallbackReason: null,
    selectedServiceTier: classified.requestedServiceTier,
    serviceTierFallbackReason: null,
    catalogGeneration: 1,
    catalogDigest: "c".repeat(64),
    now: NOW,
  });
  store.prepareProviderThread(PANE, turnId, {
    accountProfileId: ACCOUNT,
    threadId: `thread_v57vaultstore_${suffix}`,
    restartThreadId: `restart_v57vaultstore_${suffix}`,
  }, NOW);
  routing.markEffectStarted({ paneId: PANE, chatTurnId: turnId, now: NOW });
  routing.accept({
    paneId: PANE,
    chatTurnId: turnId,
    acceptedGeneration: 1,
    acceptedStreamPosition: 0,
    now: NOW,
  });
  store.markTurnAccepted(
    PANE,
    turnId,
    `providerturn_v57vaultstore_${suffix}`,
    NOW,
  );
  routing.settle({
    paneId: PANE,
    chatTurnId: turnId,
    outcome: "failed",
    now: NOW,
  });
  const terminal = store.enterAttention({
    paneId: PANE,
    turnId,
    attention: {
      code: "turn_failed",
      message: "The Store-valid v57 provider turn is terminal.",
      retryable: false,
    },
    clearBinding: false,
    now: NOW,
  });
  if (terminal === null) {
    throw new Error("Expected Store-valid v57 provider ownership");
  }
}

function finalizeProviderArchivePaneTargetThroughStoreV57(
  database: Database,
  vault: SQLiteChatAttachmentVault,
  suffix: string,
): Readonly<{
  targetId: string;
  containmentReceipt: string;
}> {
  const store = new ChatPaneStore(database, {
    messageRequestDigestKey: new Uint8Array(operationReceiptKeyByteLength)
      .fill(0x5e),
    paneArchiveAuthority: vault,
  });
  const pane = store.require(PANE).projection;
  const targetId = `archtarget_v57storefinal_${suffix}`;
  store.prepareProviderThreadArchiveEffectStartedV57({
    targetId,
    attemptId: `archattempt_v57storefinal_${suffix}`,
    paneId: PANE,
    purpose: "pane_archive",
    expectedRevision: pane.revision,
    expectedQueueRevision: null,
    generation: 1,
    now: NOW,
  });
  store.recordProviderThreadArchiveDirectAppliedV57({
    targetId,
    responseGeneration: 1,
    responseStreamPosition: 0,
    providerContainmentReceipt: `provider-store-final-${suffix}`,
    now: later(1),
  });
  const finalized = store.finalizeProviderThreadArchiveTargetV57({
    targetId,
    now: later(2),
  });
  if (finalized.kind !== "pane_archive") {
    throw new Error("Expected Store-owned pane-archive finalization");
  }
  expect(store.verifyProviderThreadArchiveTerminalAuthorityV57())
    .toContain(targetId);
  return { targetId, containmentReceipt: finalized.containmentReceipt };
}

function prepareProviderArchiveTargetThroughStoreV57(
  database: Database,
  vault: SQLiteChatAttachmentVault,
  suffix: string,
): void {
  const store = new ChatPaneStore(database, {
    messageRequestDigestKey: new Uint8Array(operationReceiptKeyByteLength)
      .fill(0x5f),
    paneArchiveAuthority: vault,
  });
  const pane = store.require(PANE).projection;
  store.prepareProviderThreadArchiveEffectStartedV57({
    targetId: `archtarget_v57late_${suffix}`,
    attemptId: `archattempt_v57late_${suffix}`,
    paneId: PANE,
    purpose: "pane_archive",
    expectedRevision: pane.revision,
    expectedQueueRevision: null,
    generation: 1,
    now: later(6),
  });
}

function insertVaultTerminalStartFreshTargetV57(
  database: Database,
  paneId: string,
  suffix: string,
): string {
  const threadId = `thread_v57_terminalsf_${suffix}`;
  const restartThreadId = `restart_v57_terminalsf_${suffix}`;
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = ?2,
      provider_thread_id = ?3,
      provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(paneId, ACCOUNT, threadId, restartThreadId);
  const profile = database.query<{
    revision: number;
    process_generation: number;
  }, [string]>(`
    SELECT revision, process_generation
    FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  const pane = database.query<{
    revision: number;
    message_queue_revision: number;
  }, [string]>(`
    SELECT revision, message_queue_revision
    FROM chat_panes WHERE pane_id = ?1
  `).get(paneId);
  if (profile === null || pane === null) {
    throw new Error("terminal start-fresh fixture authority disappeared");
  }
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x61),
  );
  const targetId = `archtarget_vaultterminalsf_${suffix}`;
  const attemptId = `archattempt_vaultterminalsf_${suffix}`;
  journal.prepareTarget({
    targetId,
    paneId,
    purpose: "start_fresh",
    paneRevision: pane.revision,
    queueRevision: pane.message_queue_revision,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: "2".repeat(64),
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    threadId,
    restartThreadId,
    binding: { kind: "none" },
    attempt: {
      attemptId,
      generation: profile.process_generation,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "3".repeat(64),
      requestRevisionDigest: "4".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId,
    effectEvidenceDigest: "5".repeat(64),
    effectRevisionDigest: "6".repeat(64),
    now: later(1),
  });
  journal.recordDirectApplied({
    attemptId,
    responseGeneration: profile.process_generation,
    responseStreamPosition: 0,
    outcomeEvidenceDigest: "7".repeat(64),
    outcomeRevisionDigest: "8".repeat(64),
    now: later(2),
  });
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = NULL,
      provider_thread_id = NULL,
      provider_restart_thread_id = NULL,
      provider_context_reset_required = 0,
      message_queue_revision = message_queue_revision + 1,
      revision = revision + 1,
      updated_at = ?2
    WHERE pane_id = ?1
  `).run(paneId, later(3).toISOString());
  journal.markTargetCommitted({
    targetId,
    commitEvidenceDigest: "9".repeat(64),
    commitRevisionDigest: "a".repeat(64),
    now: later(3),
  });
  return targetId;
}

function insertCommittedStartFreshProviderArchiveTargetV57(
  database: Database,
  suffix: string,
): void {
  const threadId = `thread_v57_committed_${suffix}`;
  const restartThreadId = `restart_v57_committed_${suffix}`;
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = ?2,
      provider_thread_id = ?3,
      provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(PANE, ACCOUNT, threadId, restartThreadId);
  const profile = database.query<{
    revision: number;
    process_generation: number;
  }, [string]>(`
    SELECT revision, process_generation
    FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null) {
    throw new Error("committed v57 privacy fixture account disappeared");
  }
  const queue = database.query<{
    message_queue_revision: number;
  }, [string]>(`
    SELECT message_queue_revision FROM chat_panes WHERE pane_id = ?1
  `).get(PANE);
  if (queue === null) {
    throw new Error("committed v57 privacy fixture pane disappeared");
  }
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x5a),
  );
  const targetId = `archtarget_vaultcommitted_${suffix}`;
  const attemptId = `archattempt_vaultcommitted_${suffix}`;
  journal.prepareTarget({
    targetId,
    paneId: PANE,
    purpose: "start_fresh",
    paneRevision: 1,
    queueRevision: queue.message_queue_revision,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: "2".repeat(64),
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    threadId,
    restartThreadId,
    binding: { kind: "none" },
    attempt: {
      attemptId,
      generation: profile.process_generation,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "3".repeat(64),
      requestRevisionDigest: "4".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId,
    effectEvidenceDigest: "5".repeat(64),
    effectRevisionDigest: "6".repeat(64),
    now: later(1),
  });
  journal.recordDirectApplied({
    attemptId,
    responseGeneration: profile.process_generation,
    responseStreamPosition: 0,
    outcomeEvidenceDigest: "7".repeat(64),
    outcomeRevisionDigest: "8".repeat(64),
    now: later(2),
  });
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = NULL,
      provider_thread_id = NULL,
      provider_restart_thread_id = NULL,
      provider_context_reset_required = 0,
      updated_at = ?2
    WHERE pane_id = ?1
  `).run(PANE, later(3).toISOString());
  journal.markTargetCommitted({
    targetId,
    commitEvidenceDigest: "9".repeat(64),
    commitRevisionDigest: "a".repeat(64),
    now: later(3),
  });
}

function insertArchiveFixtureAccount(
  database: Database,
  accountProfileId: string,
  generation: number,
): void {
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Archive privacy fixture', 'signed_in', ?2, 0, ?3, ?3)
  `).run(accountProfileId, generation, NOW.toISOString());
}

function bindFixturePaneToProviderGenerationV57(
  database: Database,
  input: Readonly<{
    paneId: string;
    accountProfileId: string;
    generation: number;
    suffix: string;
  }>,
): void {
  const chatTurnId = `chatturn_vaultprivacy_${input.suffix}`;
  const threadId = `thread_vaultprivacy_${input.suffix}`;
  const restartThreadId = `restart_vaultprivacy_${input.suffix}`;
  database.query(`
    UPDATE chat_panes SET
      account_profile_id = ?2,
      provider_account_profile_id = ?2,
      provider_thread_id = ?3,
      provider_restart_thread_id = ?4,
      active_turn_id = ?5,
      active_provider_turn_id = ?6,
      turn_status = 'completed',
      turn_started_at = ?7,
      turn_completed_at = ?8,
      visited_account_ids_json = ?9
    WHERE pane_id = ?1
  `).run(
    input.paneId,
    input.accountProfileId,
    threadId,
    restartThreadId,
    chatTurnId,
    `providerturn_vaultprivacy_${input.suffix}`,
    NOW.toISOString(),
    later(1).toISOString(),
    JSON.stringify([input.accountProfileId]),
  );
  database.query(`
    INSERT INTO harness_root_turn_routing_receipts (
      pane_id, chat_turn_id, root_turn_id, policy_version,
      required_input_class, classification_reason, work_class,
      requested_profile, requested_service_tier, state,
      selected_profile, profile_fallback_reason,
      selected_service_tier, service_tier_fallback_reason,
      operational_outcome, accepted_generation, accepted_stream_position,
      catalog_generation, catalog_digest,
      created_at, updated_at, resolved_at, effect_started_at,
      accepted_at, settled_at
    ) VALUES (
      ?1, ?2, NULL, 1,
      'text', 'conservativeDefault', 'standard',
      'solMax', 'standard', 'terminal',
      'solMax', NULL,
      'standard', NULL,
      'succeeded', ?3, 0,
      ?3, ?4,
      ?5, ?8, ?6, ?6,
      ?7, ?8
    )
  `).run(
    input.paneId,
    chatTurnId,
    input.generation,
    "a".repeat(64),
    NOW.toISOString(),
    later(1).toISOString(),
    later(2).toISOString(),
    later(3).toISOString(),
  );
}

function insertUnsealedProviderArchiveCutV57(
  database: Database,
  input: Readonly<{
    accountProfileId: string;
    sourceGeneration: number;
    cause: "lost_response" | "account_removal";
    suffix: string;
    fenced?: boolean;
  }>,
): void {
  const profile = database.query<{
    revision: number;
  }, [string]>(`
    SELECT revision FROM account_profiles WHERE profile_id = ?1
  `).get(input.accountProfileId);
  if (profile === null) {
    throw new Error("v57 privacy cut fixture account disappeared");
  }
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x59),
  );
  let initiatingAttemptId: string | null = null;
  if (input.cause === "lost_response") {
    const targetPaneId = `pane_vaultprivacycut_${input.suffix}`;
    const targetId = `archtarget_vaultprivacycut_${input.suffix}`;
    const attemptId = `archattempt_vaultprivacycut_${input.suffix}`;
    insertAdditionalPane(database, targetPaneId, 1);
    database.query(`
      UPDATE chat_panes SET
        account_profile_id = ?2,
        provider_account_profile_id = ?2,
        provider_thread_id = ?3,
        provider_restart_thread_id = ?4
      WHERE pane_id = ?1
    `).run(
      targetPaneId,
      input.accountProfileId,
      `thread_vaultprivacycut_${input.suffix}`,
      `restart_vaultprivacycut_${input.suffix}`,
    );
    journal.prepareTarget({
      targetId,
      paneId: targetPaneId,
      purpose: "pane_archive",
      paneRevision: 1,
      queueRevision: null,
      paneCasDigest: "1".repeat(64),
      queueCasDigest: null,
      accountProfileId: input.accountProfileId,
      accountProfileRevision: profile.revision,
      threadId: `thread_vaultprivacycut_${input.suffix}`,
      restartThreadId: `restart_vaultprivacycut_${input.suffix}`,
      binding: { kind: "none" },
      attempt: {
        attemptId,
        generation: input.sourceGeneration,
        accountProfileRevision: profile.revision,
        requestEvidenceDigest: "2".repeat(64),
        requestRevisionDigest: "3".repeat(64),
      },
      now: NOW,
    });
    journal.markEffectStarted({
      attemptId,
      effectEvidenceDigest: "4".repeat(64),
      effectRevisionDigest: "5".repeat(64),
      now: later(1),
    });
    initiatingAttemptId = attemptId;
  }
  const cutId = `archcut_vaultprivacycut_${input.suffix}`;
  journal.createCut({
    cutId,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: profile.revision,
    sourceGeneration: input.sourceGeneration,
    cause: input.cause,
    initiatingAttemptId,
    predecessorCutId: null,
    identityEvidenceDigest: "6".repeat(64),
    identityRevisionDigest: "7".repeat(64),
    now: later(2),
  });
  if (input.fenced === true) {
    for (const attempt of journal.bindAllAffectedTargets(cutId)) {
      journal.recordAmbiguous({
        attemptId: attempt.attemptId,
        ambiguityEvidenceDigest: "8".repeat(64),
        ambiguityRevisionDigest: "9".repeat(64),
        now: later(2),
      });
    }
    const successorRevision = profile.revision + 1;
    const advanced = database.query(`
      UPDATE account_profiles
      SET process_generation = ?2, revision = ?3, updated_at = ?4
      WHERE profile_id = ?1 AND process_generation = ?5 AND revision = ?6
    `).run(
      input.accountProfileId,
      input.sourceGeneration + 1,
      successorRevision,
      later(3).toISOString(),
      input.sourceGeneration,
      profile.revision,
    );
    if (advanced.changes !== 1) {
      throw new Error("v57 privacy cut fixture generation did not advance");
    }
    journal.recordFence({
      cutId,
      successorGeneration: input.sourceGeneration + 1,
      successorAccountProfileRevision: successorRevision,
      fenceEvidenceDigest: "a".repeat(64),
      fenceRevisionDigest: "b".repeat(64),
      now: later(3),
    });
  }
}

function insertPendingProviderArchiveMemberV57(
  database: Database,
  memberState: "pending" | "settled" = "pending",
): void {
  const targetPaneId = "pane_v57privacytarget1";
  insertAdditionalPane(database, targetPaneId, 1);
  database.query(`
    UPDATE chat_panes SET
      provider_account_profile_id = ?2,
      provider_thread_id = CASE pane_id
        WHEN ?1 THEN 'thread_v57_privacy_member'
        ELSE 'thread_v57_privacy_target'
      END,
      provider_restart_thread_id = CASE pane_id
        WHEN ?1 THEN 'restart_v57_privacy_member'
        ELSE 'restart_v57_privacy_target'
      END
    WHERE pane_id IN (?1, ?3)
  `).run(PANE, ACCOUNT, targetPaneId);
  const profile = database.query<{
    revision: number;
  }, [string]>(`
    SELECT revision FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null) throw new Error("v57 member fixture account disappeared");
  const journal = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(operationReceiptKeyByteLength).fill(0x58),
  );
  const targetId = "archtarget_vaultprivacy_membertarget01";
  const attemptId = "archattempt_vaultprivacy_membertarget01";
  const cutId = "archcut_vaultprivacy_member01";
  journal.prepareTarget({
    targetId,
    paneId: targetPaneId,
    purpose: "pane_archive",
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: null,
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    threadId: "thread_v57_privacy_target",
    restartThreadId: "restart_v57_privacy_target",
    binding: { kind: "none" },
    attempt: {
      attemptId,
      generation: 1,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "2".repeat(64),
      requestRevisionDigest: "3".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId,
    effectEvidenceDigest: "4".repeat(64),
    effectRevisionDigest: "5".repeat(64),
    now: later(1),
  });
  journal.createCut({
    cutId,
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    sourceGeneration: 1,
    cause: "lost_response",
    initiatingAttemptId: attemptId,
    predecessorCutId: null,
    identityEvidenceDigest: "6".repeat(64),
    identityRevisionDigest: "7".repeat(64),
    now: later(2),
  });
  journal.bindAttemptToCut(attemptId, cutId);
  journal.recordAmbiguous({
    attemptId,
    ambiguityEvidenceDigest: "8".repeat(64),
    ambiguityRevisionDigest: "9".repeat(64),
    now: later(3),
  });
  const successorRevision = profile.revision + 1;
  const advanced = database.query(`
    UPDATE account_profiles SET process_generation = 2, revision = ?2,
      updated_at = ?3
    WHERE profile_id = ?1 AND process_generation = 1 AND revision = ?4
  `).run(ACCOUNT, successorRevision, later(4).toISOString(), profile.revision);
  if (advanced.changes !== 1) {
    throw new Error("v57 member fixture generation did not advance");
  }
  journal.recordFence({
    cutId,
    successorGeneration: 2,
    successorAccountProfileRevision: successorRevision,
    fenceEvidenceDigest: "a".repeat(64),
    fenceRevisionDigest: "b".repeat(64),
    now: later(4),
  });
  const siblingMember = {
    memberId: "archmember_vaultprivacy_member01",
    cutId,
    paneId: PANE,
    paneRevision: 1,
    paneCasDigest: "c".repeat(64),
    threadId: "thread_v57_privacy_member",
    restartThreadId: "restart_v57_privacy_member",
    role: "sibling",
    targetId: null,
    attemptId: null,
    targetAttemptOrdinal: null,
    action: "contain_generation_context",
    binding: { kind: "none" },
    identityEvidenceDigest: "d".repeat(64),
    identityRevisionDigest: "e".repeat(64),
    now: later(5),
  } as const;
  journal.addCutMember(siblingMember);
  if (memberState === "pending") return;
  const targetMember = {
    memberId: "archmember_vaultprivacy_membertarget01",
    cutId,
    paneId: targetPaneId,
    paneRevision: 1,
    paneCasDigest: "1".repeat(64),
    threadId: "thread_v57_privacy_target",
    restartThreadId: "restart_v57_privacy_target",
    role: "target" as const,
    targetId,
    attemptId,
    targetAttemptOrdinal: 1,
    action: "preserved_target" as const,
    binding: { kind: "none" as const },
    identityEvidenceDigest: "f".repeat(64),
    identityRevisionDigest: "0".repeat(64),
    now: later(6),
  } as const;
  journal.addCutMember(targetMember);
  journal.sealCutInventory({
    cutId,
    expectedMemberCount: 2,
    expectedInventoryDigest: providerThreadArchiveCompleteInventoryDigestV57([
      siblingMember,
      targetMember,
    ]),
    enumerationAuthorityDigest: "1".repeat(64),
    sealRevisionDigest: "2".repeat(64),
    now: later(7),
  });
  journal.settleMember({
    memberId: siblingMember.memberId,
    settlementEvidenceDigest: "3".repeat(64),
    settlementRevisionDigest: "4".repeat(64),
    now: later(8),
  });
}

function insertAdditionalPane(
  database: Database,
  paneId: string,
  displayOrder: number,
): void {
  const hasPalette = database.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM pragma_table_info('chat_panes')
    WHERE name = 'palette_index'
  `).get()?.count === 1;
  database.query(`
    INSERT INTO chat_panes (
      pane_id, ${hasPalette ? "palette_index," : ""}
      display_order, repository_id, repository_name, revision, title,
      account_profile_id, model, reasoning_effort, service_tier,
      interaction_mode, state,
      workspace_mode, workspace_state, workspace_revision,
      workspace_recovery_reason, created_at, updated_at
    ) VALUES (
      ?1, ${hasPalette ? `${String(displayOrder)},` : ""}
      ?2, ?3, 'Global quota fixture', 1, 'Global quota fixture',
      ?4, 'gpt-5.6-sol', 'max', 'standard',
      'chat', 'ready', 'managed_worktree', 'preparing', 1,
      NULL, ?5, ?5
    )
  `).run(
    paneId,
    displayOrder,
    `repo_${String(displayOrder).repeat(26)}`,
    ACCOUNT,
    NOW.toISOString(),
  );
}

function insertReceivingReservation(
  database: Database,
  paneId: string,
  attachmentId: string,
  uploadId: string,
  expectedBytes: number,
  now: Date,
): void {
  database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state, kind,
      display_name, declared_media_type, internal_suffix,
      expected_input_bytes, received_input_bytes, next_chunk_ordinal,
      created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, 2, 'receiving', 'file',
      'reservation.bin', 'application/octet-stream', 'bin',
      ?4, 0, 0, ?5, ?5
    )
  `).run(attachmentId, uploadId, paneId, expectedBytes, now.toISOString());
}

function insertReceivingReservationsTotal(
  database: Database,
  paneId: string,
  totalBytes: number,
  label: string,
): void {
  let remaining = totalBytes;
  let index = 0;
  while (remaining > 0) {
    const bytes = Math.min(24 * 1024 * 1024, remaining);
    insertReceivingReservation(
      database,
      paneId,
      `attachment_${label}quota${String(index).padStart(4, "0")}`,
      `upload_${label}quota${String(index).padStart(4, "0")}`,
      bytes,
      later(10 + index),
    );
    remaining -= bytes;
    index += 1;
  }
}

function insertReadyMetadataOnly(
  database: Database,
  paneId: string,
  attachmentId: string,
  uploadId: string,
  now: Date,
): void {
  const digest = sha256(Buffer.from([0]));
  database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state, kind,
      display_name, declared_media_type, effective_media_type,
      internal_suffix, expected_input_bytes, received_input_bytes,
      source_retained,
      next_chunk_ordinal, finalize_request_revision,
      requested_input_sha256, input_sha256,
      provider_bytes, provider_sha256, ready_at, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, 1, 'ready', 'file',
      'projection.bin', 'application/octet-stream', 'application/octet-stream',
      'bin', 1, 1, 0, 1, 1, ?4, ?4, 1, ?4, ?5, ?5, ?5
    )
  `).run(attachmentId, uploadId, paneId, digest, now.toISOString());
}

class FixtureNormalizer implements ChatImageNormalizer {
  async normalize(
    inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    const source = await readFile(inputPath);
    const canonical = Buffer.from("canonical", "utf8");
    const preview = Buffer.from("preview", "utf8");
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(join(outputDirectory, "canonical.png"), canonical, { mode: 0o600 });
    await writeFile(join(outputDirectory, "preview.png"), preview, { mode: 0o600 });
    return {
      schemaVersion: 1,
      mediaType: "image/png",
      sourceBytes: source.length,
      canonical: { width: 4, height: 2, bytes: canonical.length, sha256: sha256(canonical) },
      preview: { width: 4, height: 2, bytes: preview.length, sha256: sha256(preview) },
    };
  }
}

class SizedFixtureNormalizer implements ChatImageNormalizer {
  readonly #canonicalBytes: number;
  readonly #previewBytes: number;

  constructor(canonicalBytes: number, previewBytes: number) {
    this.#canonicalBytes = canonicalBytes;
    this.#previewBytes = previewBytes;
  }

  async normalize(
    inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    const source = await readFile(inputPath);
    const canonical = Buffer.alloc(this.#canonicalBytes, 0x63);
    const preview = Buffer.alloc(this.#previewBytes, 0x70);
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(join(outputDirectory, "canonical.png"), canonical, { mode: 0o600 });
    await writeFile(join(outputDirectory, "preview.png"), preview, { mode: 0o600 });
    return {
      schemaVersion: 1,
      mediaType: "image/png",
      sourceBytes: source.length,
      canonical: {
        width: 1,
        height: 1,
        bytes: canonical.length,
        sha256: sha256(canonical),
      },
      preview: {
        width: 1,
        height: 1,
        bytes: preview.length,
        sha256: sha256(preview),
      },
    };
  }
}

class ResidueFailingNormalizer implements ChatImageNormalizer {
  readonly #residueName: string;

  constructor(residueName: string) {
    this.#residueName = residueName;
  }

  async normalize(
    _inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    const residue = join(dirname(outputDirectory), this.#residueName);
    await mkdir(residue, { mode: 0o700 });
    await writeFile(
      join(residue, "canonical.png"),
      Buffer.alloc(1024 * 1024, 0x72),
      { mode: 0o600 },
    );
    throw new Error("fixture normalizer timeout");
  }
}

class FinalGenerationFailingNormalizer implements ChatImageNormalizer {
  async normalize(
    _inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(
      join(outputDirectory, "canonical.png"),
      Buffer.from("unreceipted canonical", "utf8"),
      { mode: 0o600 },
    );
    await writeFile(
      join(outputDirectory, "preview.png"),
      Buffer.from("unreceipted preview", "utf8"),
      { mode: 0o600 },
    );
    throw new Error("fixture crash after normalized generation rename");
  }
}

class HardLinkedResidueFailingNormalizer implements ChatImageNormalizer {
  readonly #residueName: string;
  calls = 0;

  constructor(residueName: string) {
    this.#residueName = residueName;
  }

  async normalize(
    _inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    this.calls += 1;
    const residue = join(dirname(outputDirectory), this.#residueName);
    await mkdir(residue, { mode: 0o700 });
    const canonical = join(residue, "canonical.png");
    await writeFile(canonical, Buffer.from("hard-linked residue", "utf8"), {
      mode: 0o600,
    });
    const vaultRoot = dirname(dirname(dirname(outputDirectory)));
    await link(canonical, join(vaultRoot, "external-temp-copy"));
    throw new Error("fixture hard-linked normalizer timeout");
  }
}

function deferredVoid(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (settle === undefined) throw new Error("deferred resolver is unavailable");
      settle();
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return new Error("expected promise to reject");
  } catch (error: unknown) {
    return error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function later(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1_000);
}
