import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import App from "./App";
import { detectRuntimeShell } from "./runtime";

document.documentElement.setAttribute("data-hra-surface", "product");
document.body.setAttribute("data-hra-surface", "product");
const rootElement = document.querySelector("#root");

if (rootElement === null) throw new Error("The HRA root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <App runtimeShellFactory={detectRuntimeShell} />
  </StrictMode>,
);
