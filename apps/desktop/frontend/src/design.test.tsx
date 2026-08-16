import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import DesignPage from "./design";
import { isDesignRoute } from "./design-route";

test("desktop browser exposes the shared gallery only at /design", () => {
  expect(isDesignRoute("/design")).toBeTrue();
  expect(isDesignRoute("/design/")).toBeTrue();
  expect(isDesignRoute("/")).toBeFalse();

  const html = renderToStaticMarkup(<DesignPage />);
  expect(html).toContain("Browser design system");
  expect(html).toContain('href="#accessibility"');
  expect(html.match(/data-design-section="true"/g)).toHaveLength(9);
});

test("production defers the gallery JavaScript and full gallery stylesheet", async () => {
  const [main, design, productStyles] = await Promise.all([
    Bun.file(new URL("./main.tsx", import.meta.url)).text(),
    Bun.file(new URL("./design.tsx", import.meta.url)).text(),
    Bun.file(new URL("./index.css", import.meta.url)).text(),
  ]);

  expect(main).toContain('lazy(() => import("./design"))');
  expect(main).not.toMatch(/from ["']\.\/design["']/u);
  expect(design).toContain('import "@hra-internal/design-kit/styles.css";');
  expect(productStyles).toContain('@import "@hra-internal/design-kit/tokens.css";');
  expect(productStyles).toContain('@import "@hra-internal/design-kit/reset.css";');
  expect(productStyles).not.toContain("@hra-internal/design-kit/styles.css");
  expect(productStyles).not.toContain("design-gallery.css");
});
