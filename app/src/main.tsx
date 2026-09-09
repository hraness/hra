import { DesignPaletteProvider } from "@hraness/design-kit/react";
import { hraAppearanceStorageKey } from "./appearance";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import "@hraness/design-kit/compiler-palettes.css";
import "./index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The application shell is missing its root element.");

createRoot(container).render(
  <StrictMode>
    <DesignPaletteProvider legacyStorageKey={null} storageKey={hraAppearanceStorageKey}>
      <App />
    </DesignPaletteProvider>
  </StrictMode>,
);
