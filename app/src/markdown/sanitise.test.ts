import { describe, expect, test } from "bun:test";

import { neutraliseText, safeHref, splitMarkdownBlocks } from "./sanitise";

describe("neutraliseText", () => {
  test("removes zero-width characters", () => {
    const hidden = "ap\u200Bp\u200Cr\u200Dove\u2060d\uFEFF";
    expect(neutraliseText(hidden)).toBe("approved");
  });

  test("removes the bidi controls that can reverse rendered text", () => {
    const spoofed = "\u202Erm -rf\u202C \u2066safe\u2069";
    expect(neutraliseText(spoofed)).toBe("rm -rf safe");
    expect(neutraliseText("\u200E\u200F\u202A\u202B\u202D\u2067\u2068")).toBe("");
  });

  test("leaves ordinary text alone", () => {
    expect(neutraliseText("plain text, hyphen - and all")).toBe("plain text, hyphen - and all");
  });
});

describe("safeHref", () => {
  test("resolves https only", () => {
    expect(safeHref("https://example.test/path")).toBe("https://example.test/path");
  });

  test("refuses every other scheme", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "java\nscript:alert(1)",
      "http://example.test",
      "data:text/html;base64,AAAA",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "mailto:someone@example.test",
    ]) {
      expect(safeHref(href)).toBeNull();
    }
  });

  test("refuses relative and empty references", () => {
    for (const href of ["", "   ", "/path", "./path", "#anchor", undefined, null]) {
      expect(safeHref(href)).toBeNull();
    }
  });

  test("refuses an href past the bound", () => {
    expect(safeHref(`https://example.test/${"a".repeat(4_000)}`)).toBeNull();
  });
});

describe("splitMarkdownBlocks", () => {
  test("splits on blank lines and marks every block but the last complete", () => {
    const blocks = splitMarkdownBlocks("one\n\ntwo\n\nthree");
    expect(blocks.map((block) => block.text)).toEqual(["one", "two", "three"]);
    expect(blocks.map((block) => block.complete)).toEqual([true, true, false]);
    expect(new Set(blocks.map((block) => block.key)).size).toBe(3);
  });

  test("keeps a fenced code block whole across its blank lines", () => {
    const text = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\ntail";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.map((block) => block.text)).toEqual([
      "intro",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "tail",
    ]);
  });

  test("keeps an unterminated fence in the growing tail block", () => {
    const blocks = splitMarkdownBlocks("intro\n\n```ts\nconst a = 1;\n\nconst b =");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.complete).toBe(false);
    expect(blocks[1]?.text).toContain("const b =");
  });

  test("keys are stable as the tail grows", () => {
    const first = splitMarkdownBlocks("one\n\ntwo");
    const second = splitMarkdownBlocks("one\n\ntwo more");
    expect(first.map((block) => block.key)).toEqual(second.map((block) => block.key));
  });

  test("an empty document has no blocks", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n  \n")).toEqual([]);
  });
});
