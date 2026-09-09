import * as stylex from "@stylexjs/stylex";

export const appearanceStyles = stylex.create({
  control: { flexShrink: 0 },
  header: {
    display: "flex",
    justifyContent: "flex-end",
    left: "env(safe-area-inset-left)",
    paddingBottom: "0.75rem",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "0.75rem",
    position: "absolute",
    right: "env(safe-area-inset-right)",
    top: "env(safe-area-inset-top)",
  },
});
