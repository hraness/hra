import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  highlightCode,
  resolveSyntaxLanguage,
} from "./syntax-highlighting";

test("foreign language names resolve into the closed supported set", () => {
  expect(resolveSyntaxLanguage("language-tsx extra")).toBe("typescript");
  expect(resolveSyntaxLanguage("bash")).toBe("shell");
  expect(resolveSyntaxLanguage("language-mdx")).toBe("markdown");
  expect(resolveSyntaxLanguage("jsonc title=config")).toBe("json");
  expect(resolveSyntaxLanguage("python")).toBe("text");
  expect(resolveSyntaxLanguage({ language: "typescript" })).toBe("text");
});

test("TypeScript, Markdown, and shell use language-aware server markup", () => {
  expect(highlightCode("const answer = 42;", "typescript").html).toContain(
    "var(--sh-keyword)",
  );
  expect(highlightCode("# Read `this`", "markdown").html).toContain(
    "syntax-token--heading",
  );
  expect(highlightCode("# Read `this`", "markdown").html).toContain(
    "syntax-token--inline",
  );
  expect(highlightCode("bun test --watch", "shell").html).toContain(
    "syntax-token--command",
  );
  expect(highlightCode("bun test --watch", "shell").html).toContain(
    "syntax-token--flag",
  );
});

test("hostile plain text is escaped instead of becoming markup", () => {
  const source = '<script data-state="hostile">alert("x")</script>';
  const highlighted = highlightCode(source, "text");
  const { document } = parseHTML(`<code>${highlighted.html}</code>`);

  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("code")?.textContent).toBe(source);
});

test("shell comments and command positions follow shell token boundaries", () => {
  const url = highlightCode("curl https://example.com/#section", "shell").html;
  const conditional = highlightCode(
    "if bun test; then echo yes; fi",
    "shell",
  ).html;

  expect(url).not.toContain("syntax-token--comment");
  expect(url).toContain("https://example.com/#section");
  expect(conditional.match(/syntax-token--command/gu)).toHaveLength(2);
});

test("syntax colors are semantic, theme-aware, and forced-color safe", async () => {
  const [stylesheet, plainSiteStylesheet] = await Promise.all([
    Bun.file(
      new URL("./syntax-highlighting.css", import.meta.url),
    ).text(),
    Bun.file(
      new URL("./plain-site.css", import.meta.url),
    ).text(),
  ]);

  expect(stylesheet).toContain("--syntax-keyword: var(--warning");
  expect(stylesheet).toContain("--syntax-string: var(--success");
  expect(stylesheet).toContain("--sh-keyword: var(--syntax-keyword)");
  expect(stylesheet).toContain("@media (forced-colors: active)");
  expect(stylesheet).toContain("color: CanvasText");
  expect(plainSiteStylesheet).toContain("--plain-syntax-keyword: #785f28");
  expect(plainSiteStylesheet).toContain("--plain-syntax-keyword: #c9ad74");
  expect(plainSiteStylesheet).toContain(".plain-site .syntax-code");
  expect(plainSiteStylesheet).toContain(
    "--syntax-keyword: var(--plain-syntax-keyword)",
  );
  expect(plainSiteStylesheet).toContain(
    "--syntax-string: var(--plain-syntax-string)",
  );
});
