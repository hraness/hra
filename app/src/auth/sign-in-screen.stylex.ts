import * as stylex from "@stylexjs/stylex";

export const signInStyles = stylex.create({
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
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
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
