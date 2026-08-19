import { describe, expect, test } from "bun:test";

import {
  AttachmentPreviewObjectUrls,
  AttachmentUploadAdmissionQueue,
  acknowledgeConsumedAttachmentProjections,
  acknowledgeAwaitingAttachmentProjections,
  attachmentRemovalCommand,
  availableAttachmentUploadSlots,
  canonicalBase64Chunk,
  finalizedAttachmentProjectionOutcome,
  rememberObservedAttachmentProjections,
  synchronizeActiveUploadRevision,
  uploadAttachmentFile,
  validateAttachmentInputBytes,
  type AttachmentUploadPort,
} from "./use-live-chat-attachments";

describe("live chat attachment adapter", () => {
  test("uploads exact sequential chunks before a digest-fenced finalize", async () => {
    const bytes = new Uint8Array(512 * 1024 + 3);
    bytes.fill(7);
    const commands: Parameters<AttachmentUploadPort["dispatch"]>[0][] = [];
    let revision = 2;
    const port: AttachmentUploadPort = {
      dispatch: (command) => {
        commands.push(command);
        if (command.type === "chat.attachment.append") revision += 2;
        if (command.type === "chat.attachment.finalize") revision += 2;
        return Promise.resolve({
          version: 3,
          operationId: "op_liveattachment01",
          ok: true,
          result: {
            type: "chatAttachment",
            paneId: "pane_liveattachment01",
            uploadId: "upload_liveattachment01",
            changed: true,
            attachment: {
              id: "attachment_liveattachment01",
              revision,
              kind: "image",
              displayName: "clipboard.png",
              mediaType: command.type === "chat.attachment.finalize"
                ? "image/png"
                : "image/png",
              bytes: command.type === "chat.attachment.begin" ? 0 : bytes.byteLength,
              state: command.type === "chat.attachment.finalize" ? "ready" : "uploading",
              previewAvailable: command.type === "chat.attachment.finalize",
            },
          },
        });
      },
    };

    const result = await uploadAttachmentFile({
      port,
      paneId: "pane_liveattachment01",
      file: new File([bytes], "clipboard.png", { type: "image/png" }),
      identity: {
        attachmentId: "attachment_liveattachment01",
        uploadId: "upload_liveattachment01",
      },
    });

    expect(commands.map(({ type }) => type)).toEqual([
      "chat.attachment.begin",
      "chat.attachment.append",
      "chat.attachment.append",
      "chat.attachment.finalize",
    ]);
    const appends = commands.filter((command) => command.type === "chat.attachment.append");
    expect(appends.map(({ chunkOrdinal }) => chunkOrdinal)).toEqual([0, 1]);
    expect(appends.map(({ expectedRevision }) => expectedRevision)).toEqual([2, 4]);
    expect(appends.map(({ base64 }) => atob(base64).length)).toEqual([512 * 1024, 3]);
    const finalize = commands.at(-1);
    expect(finalize).toMatchObject({
      type: "chat.attachment.finalize",
      expectedRevision: 6,
      inputSha256: "bb87f6b19d1482f998210810e8b6dfe4b2d633bb7296f145d4f78e1b14877441",
    });
    expect(result).toMatchObject({ state: "ready", previewAvailable: true });
  });

  test("uses the active upload revision when projection hydration is deferred", () => {
    expect(attachmentRemovalCommand({
      paneId: "pane_liveattachment01",
      attachment: {
        id: "attachment_liveattachment01",
        revision: 2,
        kind: "file",
        displayName: "notes.txt",
        mediaType: "text/plain",
        bytes: 0,
        state: "uploading",
        previewAvailable: false,
      },
      activeUpload: { uploadId: "upload_liveattachment01", revision: 8 },
    })).toMatchObject({
      type: "chat.attachment.cancel",
      expectedRevision: 8,
    });
  });

  test("advances active cancellation after a lost append response is projected", () => {
    const active = { uploadId: "upload_liveattachment01", revision: 4 };
    synchronizeActiveUploadRevision(active, 6);
    expect(active.revision).toBe(6);
    synchronizeActiveUploadRevision(active, 4);
    expect(active.revision).toBe(6);
  });

  test("counts locally admitted files before the next projection arrives", () => {
    expect(availableAttachmentUploadSlots(6, 0)).toBe(2);
    expect(availableAttachmentUploadSlots(6, 2)).toBe(0);
    expect(availableAttachmentUploadSlots(8, 1)).toBe(0);
  });

  test("serializes rapid selections and rejects known excess before work starts", async () => {
    const queue = new AttachmentUploadAdmissionQueue();
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    const run = async (item: string): Promise<void> => {
      starts.push(item);
      await new Promise<void>((resolve) => releases.set(item, resolve));
    };
    const first = queue.enqueue({ draftCount: 6, items: ["a", "b"], run });
    const second = queue.enqueue({ draftCount: 6, items: ["c"], run });
    expect(first).toMatchObject({ acceptedCount: 2, rejectedCount: 0 });
    expect(second).toMatchObject({ acceptedCount: 0, rejectedCount: 1 });
    expect(queue.locallyAdmitted).toBe(2);
    await Promise.resolve();
    expect(starts).toEqual(["a"]);
    releases.get("a")?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual(["a", "b"]);
    releases.get("b")?.();
    await first.settled;
    await second.settled;
    expect(queue.locallyAdmitted).toBe(0);
  });

  test("retains a finalized admission until the authoritative draft projection arrives", async () => {
    const queue = new AttachmentUploadAdmissionQueue();
    const finalized = queue.enqueue({
      draftCount: 7,
      items: ["a"],
      run: () => Promise.resolve("awaitingProjection" as const),
    });
    await finalized.settled;
    expect(queue.locallyAdmitted).toBe(1);
    const beforeHydration = queue.enqueue({
      draftCount: 7,
      items: ["b"],
      run: () => Promise.resolve(undefined),
    });
    expect(beforeHydration).toMatchObject({ acceptedCount: 0, rejectedCount: 1 });
    await beforeHydration.settled;
    queue.acknowledgeProjected();
    const afterHydration = queue.enqueue({
      draftCount: 7,
      items: ["c"],
      run: () => Promise.resolve(undefined),
    });
    expect(afterHydration).toMatchObject({ acceptedCount: 1, rejectedCount: 0 });
    await afterHydration.settled;
  });

  test("projection and finalize responses converge in either order without leaking slots", async () => {
    const queue = new AttachmentUploadAdmissionQueue();
    for (let index = 0; index < 8; index += 1) {
      const attachmentId = `attachment_projectionrace${String(index).padStart(2, "0")}`;
      const awaitingIds = new Set<string>();
      const observedIds = new Set<string>();
      const projectedIds = new Set<string>();
      if (index % 2 === 0) projectedIds.add(attachmentId);
      const admission = queue.enqueue({
        draftCount: 7,
        items: [attachmentId],
        run: (id) => Promise.resolve(finalizedAttachmentProjectionOutcome({
          attachmentId: id,
          projectedIds,
          observedIds,
          consumedIds: new Set(),
          awaitingIds,
        })),
      });
      await admission.settled;
      if (index % 2 === 0) {
        expect(queue.locallyAdmitted).toBe(0);
      } else {
        expect(queue.locallyAdmitted).toBe(1);
        projectedIds.add(attachmentId);
        const acknowledged = acknowledgeAwaitingAttachmentProjections({
          projectedIds,
          awaitingIds,
          observedIds,
        });
        expect(acknowledged).toBe(1);
        queue.acknowledgeProjected(acknowledged);
      }
      expect(queue.locallyAdmitted).toBe(0);
    }
  });

  test("releases all slots when projection is consumed before finalize responds", async () => {
    const queue = new AttachmentUploadAdmissionQueue();
    for (let index = 0; index < 8; index += 1) {
      const attachmentId = `attachment_consumedrace${String(index).padStart(2, "0")}`;
      const projectedIds = new Set<string>([attachmentId]);
      const observedIds = new Set<string>();
      rememberObservedAttachmentProjections({
        projectedIds,
        trackedIds: new Set([attachmentId]),
        observedIds,
      });

      // Enqueue or removal can consume the authoritative draft projection while
      // the finalize response is still crossing the renderer bridge.
      projectedIds.delete(attachmentId);
      const consumedIds = index % 2 === 0
        ? new Set<string>([attachmentId])
        : new Set<string>();
      const awaitingIds = new Set<string>();
      const admission = queue.enqueue({
        draftCount: 7,
        items: [attachmentId],
        run: (id) => Promise.resolve(finalizedAttachmentProjectionOutcome({
          attachmentId: id,
          projectedIds,
          observedIds,
          consumedIds,
          awaitingIds,
        })),
      });
      await admission.settled;
      expect(awaitingIds).toEqual(new Set());
      expect(observedIds).toEqual(new Set());
      expect(queue.locallyAdmitted).toBe(0);
    }
  });

  test("releases all slots when enqueue consumes an awaiting finalize", async () => {
    const queue = new AttachmentUploadAdmissionQueue();
    for (let index = 0; index < 8; index += 1) {
      const attachmentId = `attachment_awaitingenqueue${String(index).padStart(2, "0")}`;
      const awaitingIds = new Set<string>();
      const observedIds = new Set<string>();
      const admission = queue.enqueue({
        draftCount: 7,
        items: [attachmentId],
        run: (id) => Promise.resolve(finalizedAttachmentProjectionOutcome({
          attachmentId: id,
          projectedIds: new Set(),
          observedIds,
          consumedIds: new Set(),
          awaitingIds,
        })),
      });
      await admission.settled;
      expect(queue.locallyAdmitted).toBe(1);
      const acknowledged = acknowledgeConsumedAttachmentProjections({
        consumedIds: [attachmentId],
        awaitingIds,
        observedIds,
      });
      expect(acknowledged).toBe(1);
      queue.acknowledgeProjected(acknowledged);
      expect(queue.locallyAdmitted).toBe(0);
    }
  });

  test("creates only normalized blob previews and revokes on revision, removal, and dispose", () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const urls = new AttachmentPreviewObjectUrls({
      create: (blob) => {
        created.push(blob);
        return `blob:preview-${created.length}`;
      },
      revoke: (url) => revoked.push(url),
    });
    const firstKey = "attachment_liveattachment01:2";
    expect(urls.install({
      key: firstKey,
      mediaType: "image/png",
      base64: "iVBORw==",
    })).toBe("blob:preview-1");
    expect(created[0]?.type).toBe("image/png");
    urls.reconcile(new Set(["attachment_liveattachment01:3"]));
    expect(revoked).toEqual(["blob:preview-1"]);
    urls.install({
      key: "attachment_liveattachment01:3",
      mediaType: "image/png",
      base64: "iVBORw==",
    });
    urls.removeAttachment("attachment_liveattachment01");
    expect(revoked).toEqual(["blob:preview-1", "blob:preview-2"]);
    urls.install({
      key: "attachment_liveattachment02:2",
      mediaType: "image/png",
      base64: "iVBORw==",
    });
    urls.dispose();
    expect(revoked).toEqual([
      "blob:preview-1",
      "blob:preview-2",
      "blob:preview-3",
    ]);
    expect(() => urls.install({
      key: "attachment_liveattachment03:2",
      mediaType: "image/jpeg",
      base64: "iVBORw==",
    })).toThrow("normalized image/png");
    expect(urls.install({
      key: "attachment_liveattachment03:2",
      mediaType: "image/png",
      base64: "iVBORw==",
    })).toBe("blob:preview-4");
  });

  test("closes input byte admission at exactly 24 MiB", () => {
    expect(validateAttachmentInputBytes(24 * 1024 * 1024)).toBe(24 * 1024 * 1024);
    expect(() => validateAttachmentInputBytes(0)).toThrow("between 1 byte and 24 MiB");
    expect(() => validateAttachmentInputBytes(24 * 1024 * 1024 + 1)).toThrow(
      "between 1 byte and 24 MiB",
    );
  });

  test("emits canonical base64 without a data URL prefix", () => {
    expect(canonicalBase64Chunk(Uint8Array.from([0, 1, 2, 3]))).toBe("AAECAw==");
  });
});
