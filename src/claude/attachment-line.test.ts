import { describe, expect, test } from "bun:test";

import type { PreparedAttachment } from "../domain/attachments.ts";
import { claudeUserLine } from "./protocol.ts";

const image: PreparedAttachment = {
  base64: "aGVsbG8=",
  byteLength: 16,
  digest: "a".repeat(64),
  kind: "image",
  mediaType: "image/png",
  name: "diagram.png",
  path: "/state/attachments/aaaa.png",
};

const text: PreparedAttachment = {
  byteLength: 7,
  digest: "b".repeat(64),
  kind: "text",
  mediaType: "text/markdown",
  name: "notes.md",
  path: "/state/attachments/bbbb.txt",
  text: "# hello",
};

const parse = (line: string): {
  message: { content: { text?: string; source?: Record<string, string>; type: string }[] };
} => JSON.parse(line.trimEnd()) as never;

describe("claudeUserLine", () => {
  test("is byte-identical to the pre-attachment line when nothing is attached", () => {
    expect(claudeUserLine("run the tests"))
      .toBe(`{"message":{"content":[{"text":"run the tests","type":"text"}],"role":"user"},"type":"user"}\n`);
  });

  test("emits one base64 image block per image, after the message text", () => {
    const content = parse(claudeUserLine("what changed?", [image])).message.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ text: "what changed?", type: "text" });
    expect(content[1]).toEqual({
      source: { data: "aGVsbG8=", media_type: "image/png", type: "base64" },
      type: "image",
    });
  });

  test("emits one text block per text attachment, with a header naming it", () => {
    const content = parse(claudeUserLine("review this", [text])).message.content;
    expect(content).toHaveLength(2);
    expect(content[1]?.type).toBe("text");
    expect(content[1]?.text?.startsWith("Attached file: notes.md (text/markdown, 7 bytes)"))
      .toBe(true);
    expect(content[1]?.text).toContain("# hello");
    // The message text is never rewritten for Claude: the file is its own block.
    expect(content[0]).toEqual({ text: "review this", type: "text" });
  });

  test("keeps attachment order and emits a single line", () => {
    const line = claudeUserLine("look", [image, text]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    const content = parse(line).message.content;
    expect(content.map((block) => block.type)).toEqual(["text", "image", "text"]);
  });
});
