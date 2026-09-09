import { DesignPaletteMenuButton } from "@hraness/design-kit/react";
import * as stylex from "@stylexjs/stylex";
import { appearanceStyles } from "./appearance.stylex";

/** The shared native menu needs no inline positioning under HRA's CSP. */
export function AppearanceButton() {
  return <div {...stylex.props(appearanceStyles.control)}><DesignPaletteMenuButton size="default" /></div>;
}

export function AppearanceHeader() {
  return (
    <header {...stylex.props(appearanceStyles.header)}>
      <AppearanceButton />
    </header>
  );
}
