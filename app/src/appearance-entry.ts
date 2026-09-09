import { bindHraAppearanceMenus, initializeHraAppearance } from "./appearance";

const appearance = initializeHraAppearance(document);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => bindHraAppearanceMenus(document, appearance), { once: true });
} else {
  bindHraAppearanceMenus(document, appearance);
}
