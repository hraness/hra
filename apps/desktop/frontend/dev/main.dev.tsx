import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../src/index.css";
import "./dev.css";

import App from "../src/App";
import { detectRuntimeShell } from "../src/runtime";
import type { RuntimeTransport } from "../src/runtime-bridge";
import { DevHud } from "./DevHud";
import { leaseDevelopmentRoot, type DevelopmentRootLease } from "./root-lease";

document.documentElement.setAttribute("data-hra-surface", "product");
document.documentElement.setAttribute("data-hra-development", "true");
document.body.setAttribute("data-hra-surface", "product");
document.title = "HRA — Dev";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The HRA root element is missing.");

const transport: RuntimeTransport | null = "zero" in window ? window.zero : null;
const hot = import.meta.hot;
const hotLease = hot?.data as unknown as DevelopmentRootLease | undefined;
const lease = hotLease ?? {};
const root = leaseDevelopmentRoot(lease, () => createRoot(rootElement));

root.render(
  <StrictMode>
    <App runtimeShellFactory={detectRuntimeShell} />
    <DevHud transport={transport} />
  </StrictMode>,
);

hot?.accept();
