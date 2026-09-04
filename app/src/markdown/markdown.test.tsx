import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown, StreamingMarkdown } from "./markdown";

/*
 * The sanitiser is proven twice: once as pure functions in `sanitise.test.ts`,
 * and once here against the real renderer, because the guarantee that matters is
 * what the markup contains after `react-markdown`, `remark-gfm`, and the
 * component overrides have all run. `renderToStaticMarkup` needs no document, so
 * this runs under `bun test ./app` like everything else.
 */
const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe("rendered markdown", () => {
  test("never renders raw HTML", () => {
    const markup = render('Hello <img src="x" onerror="alert(1)"> <b>bold</b> world');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("onerror");
  });

  test("never renders a raw script element", () => {
    const markup = render("<script>alert(1)</script>\n\ntext");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("alert(1)");
  });

  test("strips a javascript: link but keeps its text", () => {
    const markup = render("[click me](javascript:alert(1))");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("click me");
  });

  test("strips an http: link but keeps its text", () => {
    const markup = render("[insecure](http://example.test/page)");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("http://example.test");
    expect(markup).toContain("insecure");
  });

  test("keeps an https link and hardens the target", () => {
    const markup = render("[safe](https://example.test/page)");
    expect(markup).toContain('href="https://example.test/page"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('target="_blank"');
  });

  test("renders an image as its alt text and never as an element", () => {
    const markup = render("![a diagram](https://example.test/a.png)");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("a diagram");
  });

  test("removes zero-width and bidi characters before rendering", () => {
    const markup = render("ap\u200Bpro\u202Eved");
    expect(markup).not.toContain("\u200B");
    expect(markup).not.toContain("\u202E");
    expect(markup).toContain("approved");
  });

  test("sets no style attribute anywhere", () => {
    const markup = render([
      "# Heading",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- item",
      "",
      "> quote",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n"));
    expect(markup).not.toContain("style=");
  });

  test("an aligned gfm table renders no style attribute", () => {
    // `hast-util-to-jsx-runtime` turns a table cell's `align` into a React
    // `style` prop by default, which `style-src 'self'` would block. The `td`
    // and `th` overrides drop every prop but the children, so nothing reaches
    // the element.
    const markup = render("| left | right |\n| :--- | ----: |\n| 1 | 2 |");
    expect(markup).not.toContain("style=");
    expect(markup).not.toContain("text-align");
  });

  test("renders gfm tables and task lists", () => {
    const markup = render("| a |\n| - |\n| 1 |\n\n- [x] done");
    expect(markup).toContain("<table");
    expect(markup).toContain('type="checkbox"');
  });

  test("streaming markdown renders every block", () => {
    const markup = renderToStaticMarkup(
      <StreamingMarkdown text={"first block\n\nsecond block\n\nthird"} />,
    );
    expect(markup).toContain("first block");
    expect(markup).toContain("second block");
    expect(markup).toContain("third");
    expect(markup).not.toContain("style=");
  });
});
