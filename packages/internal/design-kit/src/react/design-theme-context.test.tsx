import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DesignPortalThemeProvider,
  useDesignPortalClassName,
  useDesignPortalTheme,
} from "./design-theme-context";

function ThemeProbe() {
  const portalClassName = useDesignPortalClassName();
  const theme = useDesignPortalTheme();
  return <div className={portalClassName} data-theme={theme}>Overlay</div>;
}

test("an explicit subtree theme remains available across React portal boundaries", () => {
  const html = renderToStaticMarkup(
    <DesignPortalThemeProvider portalClassName="product-theme" theme="dark">
      <ThemeProbe />
    </DesignPortalThemeProvider>,
  );

  expect(html).toBe('<div class="product-theme" data-theme="dark">Overlay</div>');
});

test("every portalled overlay reapplies the contextual theme on its portal root", async () => {
  for (const file of ["inline-help.tsx", "menu.tsx", "modal.tsx", "tooltip.tsx"]) {
    const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
    expect(source).toContain("const designTheme = useDesignPortalTheme();");
    expect(source).toContain("const portalClassName = useDesignPortalClassName();");
    expect(source).toContain("data-theme={designTheme}");
    expect(source).toContain("portalClassName");
  }
});
