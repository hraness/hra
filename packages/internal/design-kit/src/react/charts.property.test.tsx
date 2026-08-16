import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import { renderToStaticMarkup } from "react-dom/server";

import { BarListChart, RangePlotChart } from "./charts";

function cssPercentages(html: string, name: string): number[] {
  return [...html.matchAll(new RegExp(`${name}:([0-9.]+)%`, "gu"))]
    .map((match) => Number(match[1]));
}

test("property: bar geometry remains bounded for arbitrary finite values", () => {
  assertProperty(fc.property(
    fc.array(fc.double({ noDefaultInfinity: true, noNaN: true }), { maxLength: 40 }),
    (values) => {
      const html = renderToStaticMarkup(
        <BarListChart
          aria-label="Generated bars"
          data={values.map((value, index) => ({
            id: String(index),
            label: `Item ${String(index)}`,
            value,
          }))}
          domain={[0, 100]}
        />,
      );

      const percentages = cssPercentages(html, "--jungle-chart-value");
      expect(percentages).toHaveLength(values.length);
      for (const percentage of percentages) {
        expect(percentage).toBeGreaterThanOrEqual(0);
        expect(percentage).toBeLessThanOrEqual(100);
      }
    },
  ), { numRuns: 300 });
});

test("property: range geometry is ordered and bounded even when endpoints arrive reversed", () => {
  assertProperty(fc.property(
    fc.array(fc.tuple(
      fc.double({ noDefaultInfinity: true, noNaN: true }),
      fc.double({ noDefaultInfinity: true, noNaN: true }),
      fc.double({ noDefaultInfinity: true, noNaN: true }),
    ), { maxLength: 30 }),
    (ranges) => {
      const html = renderToStaticMarkup(
        <RangePlotChart
          aria-label="Generated ranges"
          data={ranges.map(([minimum, median, maximum], index) => ({
            id: String(index),
            label: `Range ${String(index)}`,
            maximum,
            median,
            minimum,
          }))}
          domain={[0, 100]}
        />,
      );

      const lefts = cssPercentages(html, "--jungle-chart-range-left");
      const widths = cssPercentages(html, "--jungle-chart-range-width");
      const medians = cssPercentages(html, "--jungle-chart-median");
      expect(lefts).toHaveLength(ranges.length);
      expect(widths).toHaveLength(ranges.length);
      expect(medians).toHaveLength(ranges.length);
      for (const values of [lefts, widths, medians]) {
        for (const percentage of values) {
          expect(percentage).toBeGreaterThanOrEqual(0);
          expect(percentage).toBeLessThanOrEqual(100);
        }
      }
    },
  ), { numRuns: 300 });
});
