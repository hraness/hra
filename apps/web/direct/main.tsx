import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  DesignThemeProvider,
  ThemeColorSync,
} from "@hra-internal/design-kit/react";

import "../app/globals.css";
import "@hraness/agent-tasks-ui/styles.css";
import "./workbench.css";

import { directAppearanceBackgroundAttribute } from "./appearance-bootstrap";
import { AgentTasksDirectWorkbench } from "./workbench";

const appearanceReceipt = window.__hraAppearanceBootstrap;
const appearanceReceiptDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "__hraAppearanceBootstrap",
);
const bootstrapBackground = document.head.querySelector(
  `style[${directAppearanceBackgroundAttribute}]`,
);
const bootstrapThemeColor = document.head.querySelector(
  "meta[data-hra-appearance-bootstrap-theme-color]",
);
const rootThemeBeforeApp = document.documentElement.dataset.theme;
const rootBackgroundBeforeApp = getComputedStyle(document.documentElement).backgroundColor;
const bodyBackgroundBeforeApp = getComputedStyle(document.body).backgroundColor;
if (
  appearanceReceipt === undefined
  || appearanceReceipt.schema !== "hra.appearance-bootstrap/v1"
  || (appearanceReceipt.resolvedTheme !== "dark" && appearanceReceipt.resolvedTheme !== "light")
  || !Object.isFrozen(appearanceReceipt)
  || appearanceReceiptDescriptor?.configurable !== false
  || appearanceReceiptDescriptor.writable !== false
  || appearanceReceiptDescriptor.value !== appearanceReceipt
  || !(bootstrapBackground instanceof HTMLStyleElement)
  || !(bootstrapThemeColor instanceof HTMLMetaElement)
  || bootstrapThemeColor.content !== appearanceReceipt.themeColor
  || rootThemeBeforeApp !== appearanceReceipt.resolvedTheme
  || rootBackgroundBeforeApp !== appearanceReceipt.backgroundColor
  || bodyBackgroundBeforeApp !== appearanceReceipt.backgroundColor
) {
  throw new Error("The HRA Direct appearance bootstrap did not complete before the app module.");
}
const verifiedAppearanceReceipt = appearanceReceipt;
const verifiedBootstrapBackground = bootstrapBackground;
const verifiedBootstrapThemeColor = bootstrapThemeColor;
document.documentElement.dataset.hraAppearanceBeforeApp = rootThemeBeforeApp;
document.documentElement.dataset.hraBackgroundBeforeApp = bodyBackgroundBeforeApp;
document.documentElement.dataset.hraRootBackgroundBeforeApp = rootBackgroundBeforeApp;
document.documentElement.dataset.hraThemeColorBeforeApp = bootstrapThemeColor.content;

function AppearanceBootstrapHandoff() {
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const active = document.head.querySelector(
        'meta[name="theme-color"][data-hra-theme-color-active]',
      );
      if (
        !(active instanceof HTMLMetaElement)
        || active.content !== verifiedAppearanceReceipt.themeColor
      ) {
        throw new Error("The HRA Direct runtime did not accept bootstrap theme-color ownership.");
      }
      verifiedBootstrapBackground.remove();
      const runtimeRootBackground = getComputedStyle(document.documentElement).backgroundColor;
      const runtimeBodyBackground = getComputedStyle(document.body).backgroundColor;
      if (
        runtimeRootBackground !== verifiedAppearanceReceipt.backgroundColor
        || runtimeBodyBackground !== verifiedAppearanceReceipt.backgroundColor
      ) {
        document.head.append(verifiedBootstrapBackground);
        throw new Error("The HRA Direct runtime did not accept bootstrap background ownership.");
      }
      verifiedBootstrapThemeColor.remove();
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The Agent Tasks Direct root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <DesignThemeProvider>
      <ThemeColorSync />
      <AppearanceBootstrapHandoff />
      <AgentTasksDirectWorkbench source={globalThis.location.search} />
    </DesignThemeProvider>
  </StrictMode>,
);
