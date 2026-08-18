import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownResponse, safeMarkdownUrl } from "./MarkdownResponse";

test("latest responses render streaming-safe Markdown without raw HTML or images", async () => {
  const html = renderToStaticMarkup(createElement(MarkdownResponse, {
    content: {
      tail: "## Result\n\n**Done.** <script>alert(1)</script> ![remote](https://example.com/a.png)",
      totalUtf8Bytes: 85,
      truncatedPrefix: false,
    },
    streaming: false,
  }));
  const source = await Bun.file(new URL("./MarkdownResponse.tsx", import.meta.url)).text();

  expect(html).toContain("Result");
  expect(html).toContain("Done.");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(source).toContain("skipHtml");
  expect(source).toContain('const disallowedElements = ["img"]');
  expect(source).not.toContain("dangerouslySetInnerHTML");
});

test("truncated response tails disclose the omitted prefix", () => {
  const html = renderToStaticMarkup(createElement(MarkdownResponse, {
    content: {
      tail: "Retained tail",
      totalUtf8Bytes: 4_096,
      truncatedPrefix: true,
    },
    streaming: true,
  }));

  expect(html).toContain("Earlier response text was omitted");
  expect(html).toContain("Retained tail");
  expect(html).toContain('data-streaming="true"');
});

test("thinking uses the same Markdown boundary and discloses its own truncation", () => {
  const html = renderToStaticMarkup(createElement(MarkdownResponse, {
    content: {
      tail: "**Checking** `state`",
      totalUtf8Bytes: 4_096,
      truncatedPrefix: true,
    },
    streaming: true,
    variant: "reasoning",
  }));

  expect(html).toContain('data-markdown-kind="reasoning"');
  expect(html).toContain('data-streamdown="strong">Checking</span>');
  expect(html).toContain('data-streamdown="inline-code">state</code>');
  expect(html).toContain("Earlier thinking was omitted");
});

test("Markdown links admit only absolute HTTP and HTTPS destinations", () => {
  expect(safeMarkdownUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
  expect(safeMarkdownUrl("http://example.com")).toBe("http://example.com/");
  expect(safeMarkdownUrl("javascript:alert(1)")).toBeNull();
  expect(safeMarkdownUrl("file:///private/example")).toBeNull();
  expect(safeMarkdownUrl("/relative")).toBeNull();
});
