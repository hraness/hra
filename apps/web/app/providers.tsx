"use client";

import {
  DesignThemeProvider,
  DesignKitRouterProvider,
  ThemeColorSync,
  type DesignKitRouterOptions,
} from "@hra-internal/design-kit/react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback } from "react";

import { HraAnalyticsProvider } from "./analytics-provider";

export function Providers({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useCallback((href: string, options: DesignKitRouterOptions | undefined) => {
    router.push(href, options);
  }, [router]);
  const prefetch = useCallback((href: string) => {
    router.prefetch(href);
  }, [router]);
  return (
    <DesignThemeProvider>
      <ThemeColorSync />
      <HraAnalyticsProvider pathname={pathname}>
        <DesignKitRouterProvider navigate={navigate} prefetch={prefetch}>
          {children}
        </DesignKitRouterProvider>
      </HraAnalyticsProvider>
    </DesignThemeProvider>
  );
}
