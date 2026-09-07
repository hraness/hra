import * as stylex from "@stylexjs/stylex";

const marketingStyles = stylex.create({
  heroExampleMeasure: { "--hraness-marketing-example-measure": "36rem" },
});

/** The public example-only variable leaves the hero summary and frame unchanged. */
export function heroExampleMeasureClassName(): string {
  return stylex.props(marketingStyles.heroExampleMeasure).className ?? "";
}
