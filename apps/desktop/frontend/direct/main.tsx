import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@hra-internal/design-kit/styles.css";
import "../src/index.css";
import "./workbench.css";

import { HRADirectWorkbench } from "./workbench";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The HRA Direct root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <HRADirectWorkbench />
  </StrictMode>,
);
