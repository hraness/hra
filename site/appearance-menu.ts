import { designPaletteLabels, designPalettes } from "@hraness/design-kit";

/** Native controls remain usable under the site's script/style-src self policy. */
export function renderAppearanceMenu(): string {
  return `<details class="hra-appearance" data-hra-appearance>
  <summary aria-label="Appearance: Catppuccin, Dark" title="Appearance">
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5 8.5 8.5 0 1 0 20.5 13.2Z"/></svg>
  </summary>
  <div class="hra-appearance__panel">
    <label>Theme<select data-hra-palette>${designPalettes.map((palette) => `<option value="${palette}"${palette === "catppuccin" ? " selected" : ""}>${designPaletteLabels[palette]}</option>`).join("")}</select></label>
    <label>Appearance<select data-hra-mode><option value="light">Light</option><option value="dark" selected>Dark</option><option value="system">System</option></select></label>
  </div>
</details>`;
}
