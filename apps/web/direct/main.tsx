import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  DesignThemeProvider,
  ThemeColorSync,
} from "@hra-internal/design-kit/react";

import "../app/globals.css";
import "@hraness/agent-tasks-ui/styles.css";
import "./workbench.css";

import { AgentTasksDirectWorkbench } from "./workbench";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The Agent Tasks Direct root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <DesignThemeProvider>
      <ThemeColorSync />
      <AgentTasksDirectWorkbench source={globalThis.location.search} />
    </DesignThemeProvider>
  </StrictMode>,
);
