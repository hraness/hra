import { designPaletteLabels, designPalettes } from "@hraness/design-kit";
import * as stylex from "@stylexjs/stylex";
import { appearanceMenuStyles as styles } from "./appearance-menu.stylex.ts";

/** The external appearance bootstrap binds these native controls after parsing. */
export function SiteAppearanceMenu() {
  return (
    <details {...stylex.props(styles.menu)} data-hra-appearance>
      <summary {...stylex.props(styles.trigger, styles.focus)} aria-label="Appearance: Catppuccin, Dark" title="Appearance">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5 8.5 8.5 0 1 0 20.5 13.2Z" />
        </svg>
      </summary>
      <div {...stylex.props(styles.panel)}>
        <label {...stylex.props(styles.label)}>
          Theme
          <select {...stylex.props(styles.select, styles.focus)} data-hra-palette defaultValue="catppuccin">
            {designPalettes.map((palette) => <option value={palette} key={palette}>{designPaletteLabels[palette]}</option>)}
          </select>
        </label>
        <label {...stylex.props(styles.label)}>
          Appearance
          <select {...stylex.props(styles.select, styles.focus)} data-hra-mode defaultValue="dark">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
      </div>
    </details>
  );
}
