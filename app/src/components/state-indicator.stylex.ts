import * as stylex from "@stylexjs/stylex";

export const stateIndicatorStyles = stylex.create({
  accent: { color: "var(--color-info)" },
  attention: { color: "var(--color-attention)" },
  danger: { color: "var(--color-danger)" },
  dot: {
    backgroundColor: "currentColor",
    height: "0.5rem",
    borderRadius: "9999px",
    display: "inline-block",
    flexShrink: 0,
    width: "0.5rem",
  },
  neutral: { color: "var(--color-ink-muted)" },
  root: {
    alignItems: "center",
    display: "inline-flex",
    fontSize: "0.75rem",
    gap: "0.375rem",
    lineHeight: "1rem",
  },
});
