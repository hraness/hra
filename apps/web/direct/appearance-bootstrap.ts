export const directAppearanceStorageKey = "jungle-design-theme-v1";
export const directAppearanceThemes = ["light", "dark", "system"] as const;
export type DirectAppearancePreference = (typeof directAppearanceThemes)[number];
export const directDefaultAppearanceTheme = "system" as const satisfies DirectAppearancePreference;
export const directAppearanceThemeColors = {
  dark: "#000000",
  light: "#fbf6f2",
} as const;
export const directAppearanceBootstrapMarker = "<!-- hra-appearance-bootstrap -->";
export const directAppearanceBootstrapAttribute = "data-hra-appearance-bootstrap-script";
export const directAppearanceBackgroundAttribute = "data-hra-appearance-bootstrap-background";
export const directAppearanceThemeColorAttribute = "data-hra-appearance-bootstrap-theme-color";

export type DirectAppearanceBootstrapState = Readonly<{
  preference: DirectAppearancePreference;
  resolvedTheme: "dark" | "light";
  themeColor: string;
}>;

export type DirectAppearanceBootstrapReceipt = Readonly<{
  backgroundColor: string;
  preference: DirectAppearancePreference;
  resolvedTheme: "dark" | "light";
  schema: "hra.appearance-bootstrap/v1";
  storageRepaired: boolean;
  storedValue: string | null;
  themeColor: string;
}>;

declare global {
  interface Window {
    readonly __hraAppearanceBootstrap?: DirectAppearanceBootstrapReceipt;
  }
}

function isDirectAppearancePreference(value: unknown): value is DirectAppearancePreference {
  return typeof value === "string"
    && directAppearanceThemes.some((theme) => theme === value);
}

export function directAppearanceBootstrapState(
  storedPreference: unknown,
  systemPrefersDark: boolean,
): DirectAppearanceBootstrapState {
  const preference = isDirectAppearancePreference(storedPreference)
    ? storedPreference
    : directDefaultAppearanceTheme;
  const resolvedTheme = preference === "system"
    ? systemPrefersDark ? "dark" : "light"
    : preference;
  return {
    preference,
    resolvedTheme,
    themeColor: directAppearanceThemeColors[resolvedTheme],
  };
}

function scriptValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Appearance bootstrap values must be JSON-safe.");
  }
  return serialized
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * Generates a dependency-free Vite head transform from values regression-locked
 * to the shared appearance runtime. Its frozen receipt survives the handoff so
 * browser evidence can prove the preference, theme, and chrome color that
 * existed before the app module.
 */
export function createDirectAppearanceBootstrapScript(): string {
  return `(()=>{const root=document.documentElement;const key=${scriptValue(directAppearanceStorageKey)};const themes=${scriptValue(directAppearanceThemes)};const fallback=${scriptValue(directDefaultAppearanceTheme)};const colors=${scriptValue(directAppearanceThemeColors)};let storedValue=null;try{storedValue=localStorage.getItem(key)}catch{}const recognized=themes.includes(storedValue);const preference=recognized?storedValue:fallback;let storageRepaired=false;if(storedValue!==null&&!recognized){try{localStorage.setItem(key,fallback);storedValue=fallback;storageRepaired=true}catch{}}const resolvedTheme=preference==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):preference;const themeColor=colors[resolvedTheme];root.dataset.theme=resolvedTheme;root.dataset.jellyMode=resolvedTheme;root.dataset.hraAppearanceBootstrap=resolvedTheme;root.dataset.hraAppearanceBootstrapPreference=preference;root.dataset.hraAppearanceBootstrapThemeColor=themeColor;const background=document.createElement("style");background.dataset.hraAppearanceBootstrapBackground="";background.textContent="html{background-color:"+themeColor+"!important;color-scheme:"+resolvedTheme+"}body{background-color:"+themeColor+"!important}";document.head.append(background);const backgroundColor=getComputedStyle(root).backgroundColor;const meta=document.createElement("meta");meta.name="theme-color";meta.content=themeColor;meta.dataset.hraAppearanceBootstrapThemeColor="";document.head.insertBefore(meta,document.head.querySelector('meta[name="theme-color"]'));Object.defineProperty(window,"__hraAppearanceBootstrap",{value:Object.freeze({backgroundColor,preference,resolvedTheme,schema:"hra.appearance-bootstrap/v1",storageRepaired,storedValue,themeColor})})})();`;
}

export const directAppearanceBootstrapScript = createDirectAppearanceBootstrapScript();

export function injectDirectAppearanceBootstrap(documentSource: string): string {
  const markerCount = documentSource.split(directAppearanceBootstrapMarker).length - 1;
  if (markerCount !== 1) {
    throw new TypeError(
      `Direct document must contain one appearance bootstrap marker; received ${markerCount}.`,
    );
  }
  const script = `<script ${directAppearanceBootstrapAttribute}="">${directAppearanceBootstrapScript}</script>`;
  return documentSource.replace(directAppearanceBootstrapMarker, script);
}
