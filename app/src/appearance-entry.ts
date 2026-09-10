import { bindOompaAppearanceMenus, initializeOompaAppearance } from "./appearance";

const appearance = initializeOompaAppearance(document);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => bindOompaAppearanceMenus(document, appearance), { once: true });
} else {
  bindOompaAppearanceMenus(document, appearance);
}
