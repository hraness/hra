import * as stylex from "@stylexjs/stylex";

const hoverCapable = "@media (hover: hover)";

export const scheduledTaskStyles = stylex.create({
  label: {
    fontSize: "0.875rem",
    fontWeight: 500,
    lineHeight: "1.25rem",
  },
  panel: {
    borderColor: "var(--color-line)",
    borderRadius: "0.375rem",
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginTop: "0.5rem",
    padding: "0.75rem",
  },
  quiet: {
    color: "var(--color-ink-muted)",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    overflowWrap: "normal",
  },
  root: {
    borderBottomColor: "var(--color-line)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    paddingBottom: "0.5rem",
    paddingLeft: "max(1rem, env(safe-area-inset-left))",
    paddingRight: "max(1rem, env(safe-area-inset-right))",
    paddingTop: "0.5rem",
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  rowHeader: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  trigger: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "var(--color-line)",
    borderRadius: "0.375rem",
    borderStyle: "solid",
    borderWidth: "1px",
    color: "var(--color-ink-muted)",
    display: "inline-flex",
    fontSize: "0.75rem",
    gap: "0.5rem",
    lineHeight: "1rem",
    minHeight: "2.75rem",
    paddingBottom: 0,
    paddingLeft: "0.75rem",
    paddingRight: "0.75rem",
    paddingTop: 0,
    ":hover": {
      color: { default: null, [hoverCapable]: "var(--color-ink)" },
    },
  },
});
