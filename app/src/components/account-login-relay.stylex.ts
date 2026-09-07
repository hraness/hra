import * as stylex from "@stylexjs/stylex";

export const accountLoginRelayStyles = stylex.create({
  code: {
    color: "var(--color-ink)",
    display: "block",
    fontFamily: "var(--font-mono)",
  },
  link: {
    color: "inherit",
    textDecorationLine: "underline",
  },
  paragraph: {
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    overflowWrap: "normal",
  },
  root: {
    color: "var(--color-ink-muted)",
    display: "flex",
    flexDirection: "column",
    fontSize: "0.75rem",
    gap: "0.25rem",
    lineHeight: "1rem",
  },
});
