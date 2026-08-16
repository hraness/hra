import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import App from "./App";
import { isDesignRoute } from "./design-route";
import { detectRuntimeShell } from "./runtime";

const DesignPage = lazy(() => import("./design"));

const designRoute = isDesignRoute(window.location.pathname);
const surface = designRoute ? "design" : "product";
document.documentElement.setAttribute("data-hra-surface", surface);
document.body.setAttribute("data-hra-surface", surface);

const content = designRoute
  ? (
      <Suspense fallback={<div className="design-loading">Loading design system…</div>}>
        <DesignPage />
      </Suspense>
    )
  : (
      <App runtimeShellFactory={detectRuntimeShell} />
    );
const rootElement = document.querySelector("#root");

if (rootElement === null) throw new Error("The HRA root element is missing.");

createRoot(rootElement).render(<StrictMode>{content}</StrictMode>);
