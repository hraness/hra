import { describe, expect, test } from "bun:test";

import {
  chatAttachmentMetadataSchema,
  parseRuntimeChatDispatchResponseForRequest,
  parseRuntimeDispatchRequest,
  runtimeProtocolVersion,
  type RuntimeChatDispatchRequest,
} from "./runtime";

const paneId = "pane_attachment01";
const attachmentId = "attachment_contract01";
const uploadId = "upload_contract01";

describe("renderer attachment contracts", () => {
  test("accepts the zero-byte receiving projection returned by begin", () => {
    expect(chatAttachmentMetadataSchema.parse({
      id: attachmentId,
      revision: 2,
      kind: "image",
      displayName: "pasted-image.png",
      mediaType: "image/png",
      bytes: 0,
      state: "uploading",
      previewAvailable: false,
    }).bytes).toBe(0);
  });

  test("closes upload chunks to the vault's exact 0..47 ordinal range", () => {
    const request = (chunkOrdinal: number) => ({
      version: runtimeProtocolVersion,
      operationId: "op_attachment01",
      command: {
        type: "chat.attachment.append",
        paneId,
        attachmentId,
        uploadId,
        expectedRevision: 2,
        chunkOrdinal,
        base64: "AQ==",
      },
    });
    expect(parseRuntimeDispatchRequest(request(47)).command).toMatchObject({ chunkOrdinal: 47 });
    expect(() => parseRuntimeDispatchRequest(request(48))).toThrow();
  });

  test("correlates upload identity, revision, and changed disposition", () => {
    const request = {
      version: runtimeProtocolVersion,
      operationId: "op_attachment02",
      command: {
        type: "chat.attachment.append",
        paneId,
        attachmentId,
        uploadId,
        expectedRevision: 2,
        chunkOrdinal: 0,
        base64: "AQ==",
      },
    } satisfies RuntimeChatDispatchRequest;
    const response = (revision: number, changed: boolean, resultUploadId = uploadId) => ({
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result: {
        type: "chatAttachment",
        paneId,
        uploadId: resultUploadId,
        attachment: {
          id: attachmentId,
          revision,
          kind: "file",
          displayName: "notes.txt",
          mediaType: "text/plain",
          bytes: 1,
          state: "uploading",
          previewAvailable: false,
        },
        changed,
      },
    });

    expect(parseRuntimeChatDispatchResponseForRequest(response(4, true), request).ok)
      .toBe(true);
    expect(parseRuntimeChatDispatchResponseForRequest(response(6, false), request).ok)
      .toBe(true);
    expect(() => parseRuntimeChatDispatchResponseForRequest(response(3, true), request))
      .toThrow("attachment revision");
    expect(() => parseRuntimeChatDispatchResponseForRequest(response(5, true), request))
      .toThrow("attachment revision");
    expect(() => parseRuntimeChatDispatchResponseForRequest(
      response(4, true, "upload_different01"),
      request,
    )).toThrow("attachment mutation");
  });
});
