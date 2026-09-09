import * as stylex from "@stylexjs/stylex";

export const enrollmentStyles = stylex.create({
  cardContent: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  error: {
    color: "var(--color-danger)",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    overflowWrap: "normal",
  },
  fingerprint: {
    backgroundColor: "var(--color-surface-input)",
    borderRadius: "0.375rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: "0.5rem",
    overflowWrap: "normal",
    padding: "0.75rem",
    userSelect: "all",
    wordBreak: "break-all",
  },
  mono: {
    fontFamily: "var(--font-mono)",
  },
  root: {
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
});
