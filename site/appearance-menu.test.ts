import { describe, expect, test } from "bun:test";
import { designPaletteLabels, designPalettes, getDesignPaletteTheme } from "@hraness/design-kit";
import { parseHTML } from "linkedom";

import { renderPreviewHtml, renderPrivacyHtml, renderSiteHtml } from "./template";

describe("public appearance delivery", () => {
  test("public pages expose one native header menu and a blocking external bootstrap", () => {
    for (const html of [renderSiteHtml(), renderPrivacyHtml()]) {
      const { document } = parseHTML(html);
      const menus = document.querySelectorAll("details[data-hra-appearance]");
      expect(menus.length).toBe(1);
      const menu = menus[0]!;
      expect(menu.closest("header")).not.toBeNull();
      expect(menu.nextElementSibling).toBeNull();
      const palettes = menu.querySelectorAll("select[data-hra-palette] option");
      expect([...palettes].map((option) => option.getAttribute("value"))).toEqual([...designPalettes]);
      expect([...palettes].map((option) => option.textContent)).toEqual(designPalettes.map((palette) => designPaletteLabels[palette]));
      expect(menu.querySelectorAll("select[data-hra-mode] option").length).toBe(3);
      const bootstrap = document.head.querySelector('script[src="/appearance.js"]');
      expect(bootstrap).not.toBeNull();
      expect(bootstrap?.hasAttribute("async")).toBe(false);
      expect(bootstrap?.hasAttribute("defer")).toBe(false);
      expect(bootstrap?.hasAttribute("type")).toBe(false);
      expect(document.querySelectorAll("[style],style").length).toBe(0);
    }
  });

  test("the inert preview carries the complete default palette without controls or scripts", () => {
    const { document } = parseHTML(renderPreviewHtml());
    const theme = getDesignPaletteTheme("catppuccin", "dark");
    expect(document.documentElement.getAttribute("data-palette")).toBe("catppuccin");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    for (const token of theme.className.split(/\s+/u)) expect(document.documentElement.classList.contains(token)).toBe(true);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(theme.background);
    expect(document.querySelectorAll("script,button,select,details,a[href],input,textarea").length).toBe(0);
  });
});
