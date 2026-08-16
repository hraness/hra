import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HranessBrand, RaMark } from "./hraness-brand";

test("renders a one-color Ra mark with transparent cutouts", () => {
  const mark = renderToStaticMarkup(<RaMark title="Sun god Ra" />);

  expect(mark).toContain('aria-label="Sun god Ra"');
  expect(mark).toContain('class="hraness-ra-mark"');
  expect(mark.match(/fill="currentColor"/g)).toHaveLength(5);
  expect(mark).toContain('fill-rule="evenodd"');
  expect(mark).not.toContain("<mask");
  expect(mark).not.toContain("<image");
});

test("renders the canonical linked lowercase lockup", () => {
  const brand = renderToStaticMarkup(<HranessBrand />);

  expect(brand).toContain('aria-label="hraness"');
  expect(brand).toContain('class="hraness-brand"');
  expect(brand).toContain('href="https://hraness.com"');
  expect(brand).toContain('<svg aria-hidden="true"');
  expect(brand).toContain('<span class="hraness-brand__name">hraness</span>');
});
