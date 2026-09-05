import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachmentDigest, AttachmentBlobStore } from "../storage/attachment-store";
import { cloudLimits } from "./contracts";
import { materializeRemoteAttachments } from "./daemon-adapters";
import { parseCompactAttachments, parseCompactSessionEvent } from "./projection";
import { parseRemoteCommandPayload, remoteAttachmentLimits } from "./payloads";

const materializationRoots: string[] = [];

afterAll(async () => {
  for (const root of materializationRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const digestOf = (value: string): string => attachmentDigest(utf8(value));

const inline = (body: string, name = "notes.md") => ({
  byteLength: utf8(body).byteLength,
  data: Buffer.from(body, "utf8").toString("base64"),
  digest: digestOf(body),
  mediaType: "text/markdown" as const,
  name,
});

describe("remote message payloads", () => {
  test("version 1 stays the exact shape it always was", () => {
    for (const kind of ["send", "queue", "steer", "send_or_steer"] as const) {
      expect(parseRemoteCommandPayload({ kind, message: "hello" }))
        .toEqual({ kind, message: "hello" });
    }
  });

  test("version 2 carries a manifest with inline bytes", () => {
    const attachment = inline("# hello");
    const parsed = parseRemoteCommandPayload({
      attachments: [attachment],
      kind: "send",
      message: "look at this",
      version: 2,
    });
    expect(parsed).toEqual({
      attachments: [attachment],
      kind: "send",
      message: "look at this",
      version: 2,
    });
  });

  test("version 2 accepts a digest-only reference the custodian already holds", () => {
    const attachment = inline("# hello");
    const reference = Object.fromEntries(
      Object.entries(attachment).filter(([key]) => key !== "data"),
    ) as Omit<typeof attachment, "data">;
    const parsed = parseRemoteCommandPayload({
      attachments: [reference],
      kind: "queue",
      message: "again",
      version: 2,
    });
    expect(parsed).toEqual({
      attachments: [reference],
      kind: "queue",
      message: "again",
      version: 2,
    });
  });

  test("refuses an unknown version, a stray key, and a missing version", () => {
    const attachment = inline("# hello");
    expect(parseRemoteCommandPayload({
      attachments: [attachment], kind: "send", message: "x", version: 3,
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      attachments: [attachment], extra: 1, kind: "send", message: "x", version: 2,
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      attachments: [attachment], kind: "send", message: "x",
    })).toBeNull();
  });

  test("refuses a name that is a path, and an unreviewed media type", () => {
    const attachment = inline("# hello");
    expect(parseRemoteCommandPayload({
      attachments: [{ ...attachment, name: "../etc/passwd" }],
      kind: "send", message: "x", version: 2,
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      attachments: [{ ...attachment, mediaType: "application/octet-stream" }],
      kind: "send", message: "x", version: 2,
    })).toBeNull();
  });

  test("refuses bytes whose length does not match the declared length", () => {
    const attachment = inline("# hello");
    expect(parseRemoteCommandPayload({
      attachments: [{ ...attachment, byteLength: attachment.byteLength + 1 }],
      kind: "send", message: "x", version: 2,
    })).toBeNull();
  });

  test("refuses one attachment over the inline bound", () => {
    const body = "x".repeat(remoteAttachmentLimits.inlineBytes + 1);
    expect(parseRemoteCommandPayload({
      attachments: [inline(body, "big.txt")], kind: "send", message: "x", version: 2,
    })).toBeNull();
  });

  test("refuses a manifest over the total inline bound, and over the count", () => {
    const chunk = "y".repeat(remoteAttachmentLimits.inlineBytes);
    const over = [0, 1].map((index) => inline(`${chunk}${String(index)}`, `f${String(index)}.txt`));
    expect(parseRemoteCommandPayload({
      attachments: over, kind: "send", message: "x", version: 2,
    })).toBeNull();
    const many = Array.from({ length: remoteAttachmentLimits.count + 1 }, (_, index) =>
      inline(`body-${String(index)}`, `f${String(index)}.txt`));
    expect(parseRemoteCommandPayload({
      attachments: many, kind: "send", message: "x", version: 2,
    })).toBeNull();
  });

  test("the largest accepted payload stays well inside the Convex ciphertext bound", () => {
    // Base64 of the inline total, plus a full-size message, plus JSON framing.
    const inlineCharacters = Math.ceil(remoteAttachmentLimits.totalInlineBytes / 3) * 4;
    const plaintext = inlineCharacters + 64_000 + 4_096;
    // AES-GCM adds a 16-byte tag; base64url of the result is 4/3 the bytes.
    const ciphertext = Math.ceil((plaintext + 16) / 3) * 4;
    expect(ciphertext).toBeLessThan(cloudLimits.ciphertextCharacters);
    // "Room to spare" is a claim worth pinning: at least 15 percent headroom.
    expect(ciphertext).toBeLessThan(cloudLimits.ciphertextCharacters * 0.85);
  });
});

describe("compact attachment manifests", () => {
  const manifest = [{
    byteLength: 7,
    digest: digestOf("# hello"),
    mediaType: "text/markdown",
    name: "notes.md",
  }];

  test("parses a bounded manifest on a user message", () => {
    expect(parseCompactSessionEvent({
      attachments: manifest,
      kind: "user_message",
      sequence: 4,
      text: "look",
      turnId: "turn_one",
    })).toEqual({
      attachments: manifest,
      kind: "user_message",
      sequence: 4,
      text: "look",
      turnId: "turn_one",
    });
  });

  test("an event with no manifest parses exactly as it did before", () => {
    expect(parseCompactSessionEvent({
      kind: "user_message", sequence: 4, text: "look", turnId: "turn_one",
    })).toEqual({ kind: "user_message", sequence: 4, text: "look", turnId: "turn_one" });
  });

  test("still accepts an unknown key from a newer writer", () => {
    expect(parseCompactSessionEvent({
      attachments: manifest,
      futureKey: "ignored",
      kind: "user_message",
      sequence: 4,
      text: "look",
      turnId: "turn_one",
    })).toEqual({
      attachments: manifest,
      kind: "user_message",
      sequence: 4,
      text: "look",
      turnId: "turn_one",
    });
  });

  test("refuses a manifest that is empty, oversized, or badly shaped", () => {
    expect(parseCompactAttachments([])).toBeNull();
    expect(parseCompactAttachments(Array.from({ length: 9 }, () => manifest[0]))).toBeNull();
    expect(parseCompactAttachments([{ ...manifest[0], name: "dir/notes.md" }])).toBeNull();
    expect(parseCompactAttachments([{ ...manifest[0], name: "/etc/passwd" }])).toBeNull();
    expect(parseCompactAttachments([{ ...manifest[0], mediaType: "application/pdf" }])).toBeNull();
    expect(parseCompactAttachments([{ ...manifest[0], digest: "short" }])).toBeNull();
    expect(parseCompactAttachments([{ ...manifest[0], byteLength: 0 }])).toBeNull();
    expect(parseCompactAttachments([{ ...manifest[0], byteLength: 6 * 1024 * 1024 }])).toBeNull();
  });

  test("a bad manifest makes the whole event unparseable rather than losing it", () => {
    expect(parseCompactSessionEvent({
      attachments: [{ ...manifest[0], name: "dir/notes.md" }],
      kind: "user_message",
      sequence: 4,
      text: "look",
      turnId: "turn_one",
    })).toBeNull();
  });

  test("an assistant message never carries a manifest", () => {
    expect(parseCompactSessionEvent({
      attachments: manifest,
      kind: "assistant_message",
      sequence: 5,
      text: "ok",
      turnId: "turn_one",
    })).toEqual({ kind: "assistant_message", sequence: 5, text: "ok", turnId: "turn_one" });
  });
});

describe("hosted attachment materialization", () => {
  const inlineImage = () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    return {
      byteLength: png.byteLength,
      bytes: png,
      data: Buffer.from(png).toString("base64"),
      digest: attachmentDigest(png),
      mediaType: "image/png" as const,
      name: "diagram.png",
    };
  };

  const fixture = async (): Promise<AttachmentBlobStore> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-hosted-attachments-")));
    materializationRoots.push(root);
    return new AttachmentBlobStore(join(root, "attachments"));
  };

  test("writes inline bytes into local custody and returns digest references", async () => {
    const blobs = await fixture();
    const attachment = inlineImage();
    const outcome = await materializeRemoteAttachments(blobs, {
      attachments: [attachment],
      kind: "send",
      message: "look",
      version: 2,
    });
    expect(outcome.kind).toBe("materialized");
    if (outcome.kind !== "materialized") return;
    expect(outcome.values).toEqual([{
      byteLength: attachment.byteLength,
      digest: attachment.digest,
      mediaType: "image/png",
      name: "diagram.png",
    }]);
    expect(await blobs.has(attachment.digest, "image/png")).toBe(true);
  });

  test("refuses a digest-only reference this machine does not hold", async () => {
    const blobs = await fixture();
    const reference = Object.fromEntries(
      Object.entries(inlineImage()).filter(([key]) => key !== "data" && key !== "bytes"),
    ) as Omit<ReturnType<typeof inlineImage>, "bytes" | "data">;
    const outcome = await materializeRemoteAttachments(blobs, {
      attachments: [reference],
      kind: "send",
      message: "look",
      version: 2,
    });
    expect(outcome).toEqual({ code: "ATTACHMENT_MISSING", kind: "refused" });
  });

  test("refuses inline bytes whose digest the sender misreported", async () => {
    const blobs = await fixture();
    const attachment = inlineImage();
    const outcome = await materializeRemoteAttachments(blobs, {
      attachments: [{ ...attachment, digest: "d".repeat(64) }],
      kind: "send",
      message: "look",
      version: 2,
    });
    expect(outcome).toEqual({ code: "ATTACHMENT_DIGEST_MISMATCH", kind: "refused" });
  });

  test("refuses inline bytes that are not what they claim to be", async () => {
    const blobs = await fixture();
    const machO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
    const outcome = await materializeRemoteAttachments(blobs, {
      attachments: [{
        byteLength: machO.byteLength,
        data: Buffer.from(machO).toString("base64"),
        digest: attachmentDigest(machO),
        mediaType: "text/plain",
        name: "innocent.txt",
      }],
      kind: "send",
      message: "look",
      version: 2,
    });
    expect(outcome).toEqual({ code: "ATTACHMENT_UNSUPPORTED_BYTES", kind: "refused" });
  });

  test("a version 1 payload materializes nothing at all", async () => {
    const blobs = await fixture();
    expect(await materializeRemoteAttachments(blobs, { kind: "send", message: "plain" }))
      .toEqual({ kind: "materialized", values: [] });
  });
});
