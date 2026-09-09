import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  figure: {
    margin: 0, width: "100%", minWidth: 0, borderRadius: "1rem",
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopColor: "var(--rule)", borderRightColor: "var(--rule)", borderBottomColor: "var(--rule)", borderLeftColor: "var(--rule)",
    backgroundColor: "var(--background)", boxShadow: "0 1.5rem 5rem color-mix(in srgb, var(--foreground) 7%, transparent)", overflow: "hidden", textAlign: "left", scrollMarginTop: "5rem",
  },
  toolbar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", padding: "0.65rem", flexWrap: "wrap", borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: "var(--rule)", backgroundColor: "var(--surface)" },
  tabs: { display: "flex", gap: "0.25rem", flexWrap: "wrap" },
  button: {
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopColor: { default: "transparent", ':is([aria-pressed="true"])': "var(--rule)" },
    borderRightColor: { default: "transparent", ':is([aria-pressed="true"])': "var(--rule)" },
    borderBottomColor: { default: "transparent", ':is([aria-pressed="true"])': "var(--rule)" },
    borderLeftColor: { default: "transparent", ':is([aria-pressed="true"])': "var(--rule)" },
    backgroundColor: { default: "transparent", ':is([aria-pressed="true"])': "var(--background)", ":hover": "var(--background)" }, color: "var(--foreground)", borderRadius: "0.4rem", padding: "0.6rem 0.75rem", fontFamily: "var(--font-sans)", fontSize: "0.8rem", cursor: "pointer", minHeight: "2.5rem", outlineOffset: "3px",
  },
  viewport: { height: { default: "36rem", "@media (max-width: 48rem)": "31rem" }, overflow: "hidden", backgroundColor: "var(--surface)" },
  frame: {
    display: "block", width: "100%", height: "100%",
    borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0,
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
    borderTopColor: "currentColor", borderRightColor: "currentColor", borderBottomColor: "currentColor", borderLeftColor: "currentColor",
    pointerEvents: "none",
  },
  caption: { padding: "1rem 1.25rem", borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "var(--rule)", fontSize: "0.8rem", lineHeight: 1.5, color: "var(--muted)" },
  description: { margin: "0 0 0.5rem", color: "var(--foreground)", fontSize: "0.95rem", maxWidth: "72ch" },
  captionMeta: { display: "flex", justifyContent: "space-between", gap: "0.6rem 2rem", flexWrap: "wrap" },
  status: { margin: "0.4rem 0 0", fontSize: "0.75rem" },
  dialog: {
    width: "min(96vw, 100rem)", maxWidth: "96vw", maxHeight: "96dvh", padding: 0,
    marginTop: "auto", marginRight: "auto", marginBottom: "auto", marginLeft: "auto",
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopColor: "var(--rule)", borderRightColor: "var(--rule)", borderBottomColor: "var(--rule)", borderLeftColor: "var(--rule)",
    borderRadius: "0.8rem", color: "var(--foreground)", backgroundColor: "var(--background)", boxShadow: "0 2rem 8rem #0006", "::backdrop": { backgroundColor: "#000a" },
  },
  dialogTitle: { margin: "0 0.5rem", fontSize: "1rem", fontWeight: 500 },
  expandedViewport: { height: "min(76dvh, 58rem)", minHeight: "20rem" },
  expandedCaption: { margin: 0, padding: "0.75rem 1rem", fontSize: "0.8rem", color: "var(--muted)", borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "var(--rule)" },
});

export function previewClasses(...slots: readonly (keyof typeof styles)[]): string {
  return stylex.props(...slots.map((slot) => styles[slot])).className ?? "";
}
