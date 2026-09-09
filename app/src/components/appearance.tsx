import { DesignPaletteMenuButton } from "@hraness/design-kit/react";

/** The shared native menu needs no inline positioning under HRA's CSP. */
export function AppearanceButton() {
  return <div className="shrink-0"><DesignPaletteMenuButton /></div>;
}

export function AppearanceHeader() {
  return (
    <header className="absolute inset-x-0 top-[env(safe-area-inset-top)] flex justify-end px-4 py-3">
      <AppearanceButton />
    </header>
  );
}
