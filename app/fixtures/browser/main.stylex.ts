import * as stylex from "@stylexjs/stylex";

export const fixtureStyles = stylex.create({
  // Keep each control's offset focus ring clear of adjacent fixture controls.
  controls: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    marginTop: "0.75rem",
    paddingBottom: "0.5rem",
  },
});
