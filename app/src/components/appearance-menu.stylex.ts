import * as stylex from "@stylexjs/stylex";

/** Native, statically positioned controls need no runtime styles under CSP. */
export const appearanceMenuStyles = stylex.create({
  menu: { color: "var(--foreground)", flexShrink: 0, position: "relative" },
  trigger: {
    alignItems: "center", backgroundColor: "var(--background)",
    borderColor: "var(--control-border)", borderStyle: "solid", borderWidth: 1,
    borderRadius: "0.5rem", cursor: "pointer", display: { default: "flex", "::-webkit-details-marker": "none" }, justifyContent: "center",
    listStyleType: "none", minHeight: "2.75rem", minWidth: "2.75rem",
  },
  focus: {
    outlineColor: { default: null, ":focus-visible": "var(--focus)" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": 2 },
    outlineOffset: { default: null, ":focus-visible": 3 },
  },
  panel: {
    backgroundColor: "var(--popover)", color: "var(--popover-foreground)",
    borderColor: "var(--control-border)", borderStyle: "solid", borderWidth: 1,
    borderRadius: "0.75rem", display: "grid", gap: "1rem",
    insetBlockStart: { default: "calc(100% + 0.5rem)", "@media (max-width: 48rem)": "calc(4.25rem + env(safe-area-inset-top, 0px))" },
    insetInlineEnd: { default: 0, "@media (max-width: 48rem)": "1rem" },
    padding: "1rem", position: { default: "absolute", "@media (max-width: 48rem)": "fixed" },
    width: "min(18rem, calc(100vw - 2rem))", zIndex: 3000,
  },
  label: { display: "grid", gap: "0.35rem" },
  select: {
    backgroundColor: "var(--surface-raised)", color: "var(--foreground)",
    borderColor: "var(--control-border)", borderStyle: "solid", borderWidth: 1,
    borderRadius: "0.35rem", fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit",
    minHeight: "2.75rem", paddingInline: "0.5rem", width: "100%",
  },
});
