"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

export type PortalDesignTheme = "dark" | "light";

interface DesignThemeContextValue {
  readonly portalClassName?: string;
  readonly theme?: PortalDesignTheme;
}

const DesignThemeContext = createContext<DesignThemeContextValue>({});

/** Keeps portalled overlays in the same explicit theme as their trigger subtree. */
export function DesignPortalThemeProvider({
  children,
  portalClassName,
  theme,
}: Readonly<{
  children: ReactNode;
  portalClassName?: string;
  theme: PortalDesignTheme | undefined;
}>) {
  const value = useMemo(
    () => ({
      ...(portalClassName === undefined ? {} : { portalClassName }),
      ...(theme === undefined ? {} : { theme }),
    }),
    [portalClassName, theme],
  );
  return <DesignThemeContext.Provider value={value}>{children}</DesignThemeContext.Provider>;
}

export function useDesignPortalTheme(): PortalDesignTheme | undefined {
  return useContext(DesignThemeContext).theme;
}

/** Reapplies a product palette selector when an overlay leaves its trigger subtree. */
export function useDesignPortalClassName(): string | undefined {
  return useContext(DesignThemeContext).portalClassName;
}
