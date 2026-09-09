import * as stylex from "@stylexjs/stylex";

const mobile = "@media (max-width: 52rem)";
const styles = stylex.create({
  layout: { maxWidth: "82rem", margin: "0 auto", padding: { default: "3rem 2rem 6rem", [mobile]: "1.5rem 1.25rem 4rem" }, display: "grid", gridTemplateColumns: { default: "13rem minmax(0, 1fr)", [mobile]: "minmax(0, 1fr)" }, gap: "clamp(2rem, 5vw, 5rem)" },
  sidebar: { alignSelf: "start", position: { default: "sticky", [mobile]: "static" }, top: "6rem", maxHeight: { default: "calc(100dvh - 7rem)", [mobile]: "none" }, overflowY: "auto", fontSize: "0.85rem", paddingBottom: "1rem" },
  sidebarHeading: { display: "block", color: "var(--foreground)", textDecoration: "none", fontWeight: 600, marginBottom: "1.5rem" },
  searchLabel: { display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.4rem" },
  search: {
    width: "100%", backgroundColor: "var(--surface)", color: "var(--foreground)",
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopColor: "var(--rule)", borderRightColor: "var(--rule)", borderBottomColor: "var(--rule)", borderLeftColor: "var(--rule)",
    borderRadius: "0.5rem", padding: "0.7rem", fontFamily: "inherit", fontSize: "inherit", fontStyle: "inherit", fontWeight: "inherit", lineHeight: "inherit", minHeight: "2.75rem", marginBottom: "1rem",
  },
  searchResults: { padding: "0.5rem 0", borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: "var(--rule)", marginBottom: "1rem" },
  nav: { display: { default: "grid", [mobile]: "flex" }, flexWrap: "wrap", gap: "0.2rem" },
  navLink: { display: "block", padding: "0.65rem 0.75rem", borderRadius: "0.4rem", textDecoration: "none", color: { default: "var(--muted)", ":hover": "var(--foreground)", ':is([aria-current="page"])': "var(--foreground)" }, backgroundColor: { default: "transparent", ':is([aria-current="page"])': "var(--surface)" }, outlineOffset: "2px" },
  pageNav: { display: { default: "grid", [mobile]: "none" }, gap: "0.7rem", marginTop: "2rem", paddingTop: "1rem", borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "var(--rule)" },
  sectionLink: { color: "var(--muted)", textDecoration: "none", lineHeight: 1.5, fontSize: "0.8rem" },
  main: { minWidth: 0, maxWidth: "61rem" },
  header: { marginBottom: "2.5rem" },
  eyebrow: { fontSize: "0.8rem", color: "var(--muted)", margin: "0 0 1.25rem" },
  title: { fontSize: "clamp(2.3rem, 4vw, 3.6rem)", fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1.08, textWrap: "balance", margin: "0 0 1.25rem" },
  lede: { maxWidth: "60ch", fontSize: "1.15rem", lineHeight: 1.6, color: "var(--muted)", margin: "0 0 1.25rem" },
  meta: { fontSize: "0.8rem", color: "var(--muted)" },
  section: { padding: "2.5rem 0", borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: "var(--rule)", scrollMarginTop: "6rem" },
  reference: { marginTop: "3rem", color: "var(--muted)" },
  details: {
    marginTop: "0.75rem",
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopColor: "var(--rule)", borderRightColor: "var(--rule)", borderBottomColor: "var(--rule)", borderLeftColor: "var(--rule)",
    borderRadius: "0.5rem", padding: "1rem 1.25rem", color: "var(--foreground)", scrollMarginTop: "6rem", fontSize: "0.95rem",
  },
  detailBody: { paddingTop: "1rem", maxWidth: "100%" },
  related: { display: "flex", flexWrap: "wrap", gap: "1rem", marginTop: "3rem" },
  relatedLink: {
    padding: "0.85rem 1rem",
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopColor: "var(--rule)", borderRightColor: "var(--rule)", borderBottomColor: "var(--rule)", borderLeftColor: "var(--rule)",
    borderRadius: "0.5rem", textDecoration: "none", fontSize: "0.9rem", color: "var(--foreground)",
  },
  legacyLinks: { maxWidth: "66rem", margin: "0 auto 3rem", padding: "1rem 1.25rem", color: "var(--muted)", fontSize: "0.85rem" },
});

export function docsClasses(...slots: readonly (keyof typeof styles)[]): string {
  return stylex.props(...slots.map((slot) => styles[slot])).className ?? "";
}
