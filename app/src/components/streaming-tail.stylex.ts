import * as stylex from "@stylexjs/stylex";

export const streamingTailStyles = stylex.create({
  root: {
    borderTopColor: "var(--color-line)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    color: "var(--color-ink-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
    lineHeight: 1.375,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    maxHeight: "10rem",
    overflowWrap: "break-word",
    overflowX: "hidden",
    overflowY: "auto",
    paddingBottom: "0.5rem",
    paddingLeft: "0.75rem",
    paddingRight: "0.75rem",
    paddingTop: "0.5rem",
    whiteSpace: "pre-wrap",
  },
});
