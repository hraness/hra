import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BarListChart, RadarProfileChart, RangePlotChart } from "./charts";

test("bar lists keep exact values visible and expose native selectable rows", () => {
  const html = renderToStaticMarkup(
    <BarListChart
      aria-label="Model performance"
      data={[
        { color: "#4f8de8", detail: "$2.10", id: "one", label: "Model one", value: 72.4 },
        { color: "#ee744f", detail: "$5.20", id: "two", label: "Model two", value: 68.1 },
      ]}
      domain={[0, 100]}
      formatValue={(value) => value.toFixed(1)}
      onSelectionChange={() => undefined}
      selectedId="one"
    />,
  );

  expect(html).toContain("Model performance");
  expect(html).toContain("Model one");
  expect(html).toContain("72.4");
  expect(html).toContain("$2.10");
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("--jungle-chart-value:72.4%");
});

test("radar profiles pair the decorative plot with exact tabular values", () => {
  const html = renderToStaticMarkup(
    <RadarProfileChart
      aria-label="Capability profiles"
      axes={[
        { id: "code", label: "Code" },
        { id: "terminal", label: "Terminal" },
        { id: "reasoning", label: "Reasoning" },
      ]}
      series={[
        {
          color: "#4f8de8",
          id: "one",
          label: "Model one",
          values: { code: 74.2, reasoning: 68.8, terminal: 81.5 },
        },
      ]}
    />,
  );

  expect(html).toContain("jungle-radar-profile-chart");
  expect(html).toContain("<table");
  expect(html).toContain("<caption>Capability profiles</caption>");
  expect(html).toContain("<th scope=\"row\">Code</th>");
  expect(html).toContain("<td>74.2</td>");
});

test("range plots label endpoints and the median marker without implying area", () => {
  const html = renderToStaticMarkup(
    <RangePlotChart
      aria-label="Provider ranges"
      data={[
        {
          color: "#4f8de8",
          detail: "4 options",
          id: "provider",
          label: "Provider",
          maximum: 82,
          median: 64,
          minimum: 38,
        },
      ]}
      formatValue={(value) => value.toFixed(0)}
    />,
  );

  expect(html).toContain("Provider ranges");
  expect(html).toContain("38–82");
  expect(html).toContain("4 options");
  expect(html).toContain("--jungle-chart-range-left:38%");
  expect(html).toContain("--jungle-chart-range-width:44%");
  expect(html).toContain("--jungle-chart-median:64%");
});

test("charts reject blank names and invalid domains", () => {
  expect(() => renderToStaticMarkup(
    <BarListChart aria-label=" " data={[]} domain={[0, 1]} />,
  )).toThrow(TypeError);
  expect(() => renderToStaticMarkup(
    <RangePlotChart aria-label="Range" data={[]} domain={[1, 1]} />,
  )).toThrow(RangeError);
});
