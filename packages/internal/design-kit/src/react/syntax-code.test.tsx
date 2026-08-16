import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SyntaxCode } from "./syntax-code";

test("SyntaxCode emits typed language metadata and highlighted server markup", () => {
  const html = renderToStaticMarkup(
    <SyntaxCode
      className="product-code"
      code={'const greeting = "hello";'}
      language="typescript"
    />,
  );

  expect(html).toContain(
    'class="syntax-code language-typescript product-code"',
  );
  expect(html).toContain('data-language="typescript"');
  expect(html).toContain("var(--sh-keyword)");
  expect(html).toContain("const");
  expect(html).not.toContain("<script");
});
