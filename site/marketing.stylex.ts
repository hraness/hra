import * as stylex from "@stylexjs/stylex";

const marketingStyles = stylex.create({
  heroExampleMeasure: { "--hraness-marketing-example-measure": "36rem" },
  // A wrapping mobile header has no fixed height. Keep fragment destinations
  // visible without changing the public component's sticky desktop default.
  mobileHeaderFlow: { position: { default: null, "@media (max-width: 48rem)": "static" } },
});

/** The public example-only variable leaves the hero summary and frame unchanged. */
export function heroExampleMeasureClassName(): string {
  return stylex.props(marketingStyles.heroExampleMeasure).className ?? "";
}

export function mobileHeaderFlowClassName(): string {
  return stylex.props(marketingStyles.mobileHeaderFlow).className ?? "";
}
