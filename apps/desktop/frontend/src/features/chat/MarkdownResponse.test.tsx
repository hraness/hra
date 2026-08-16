import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownResponse } from "./MarkdownResponse";

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
