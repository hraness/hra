import * as stylex from "@stylexjs/stylex";

export const appStyles = stylex.create({
  centered: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    justifyContent: "center",
    marginLeft: "auto",
    marginRight: "auto",
    maxWidth: "28rem",
    minHeight: "100dvh",
    padding: "1rem",
  },
  quiet: {
    color: "var(--color-ink-muted)",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    overflowWrap: "normal",
  },
});
