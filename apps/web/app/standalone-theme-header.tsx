"use client";

import {
  ThemeMenuButton,
  TopBar,
} from "@hra-internal/design-kit/react";

/** The sole appearance action for standalone HRA document states. */
export function StandaloneThemeHeader() {
  return (
    <TopBar
      actions={<ThemeMenuButton />}
      aria-label="Page controls"
      className="standalone-header"
    />
  );
}
