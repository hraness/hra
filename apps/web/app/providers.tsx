"use client";

import type { ConvexDeployment } from "@hra-internal/convex";
import {
  DesignThemeProvider,
  DesignKitRouterProvider,
  ThemeColorSync,
  type DesignKitRouterOptions,
} from "@hra-internal/design-kit/react";
import {
  AuthKitProvider,
  useAccessToken,
  useAuth,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useMemo } from "react";

import { isHraPublicComparisonPath } from "./alternatives/slugs";

function useWorkOSConvexAuth() {
  const { loading, user } = useAuth();
  const { getAccessToken, loading: tokenLoading, refresh } = useAccessToken();
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const token = forceRefreshToken ? await refresh() : await getAccessToken();
      return token ?? null;
    },
    [getAccessToken, refresh],
  );

  return useMemo(() => ({
    fetchAccessToken,
    isLoading: loading || tokenLoading,
    isAuthenticated: user !== null,
  }), [fetchAccessToken, loading, tokenLoading, user]);
}

function ConvexAuthBridge({ children, url }: { children: ReactNode; url: string }) {
  const client = useMemo(() => new ConvexReactClient(url), [url]);
  return (
    <ConvexProviderWithAuth client={client} useAuth={useWorkOSConvexAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}

export function Providers({
  authConfigured,
  children,
  deployment,
}: {
  authConfigured: boolean;
  children: ReactNode;
  deployment: ConvexDeployment;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useCallback((href: string, options: DesignKitRouterOptions | undefined) => {
    router.push(href, options);
  }, [router]);
  const prefetch = useCallback((href: string) => {
    router.prefetch(href);
  }, [router]);
  const standalonePublicRoute =
    pathname === "/"
    || pathname === "/download"
    || pathname === "/download/"
    || isHraPublicComparisonPath(pathname);
  const content = standalonePublicRoute || !authConfigured ? children : (
    <AuthKitProvider>
      {deployment.kind !== "ready" ? (
        children
      ) : (
        <ConvexAuthBridge url={deployment.url}>{children}</ConvexAuthBridge>
      )}
    </AuthKitProvider>
  );

  return (
    <DesignThemeProvider>
      <ThemeColorSync />
      <DesignKitRouterProvider navigate={navigate} prefetch={prefetch}>
        {content}
      </DesignKitRouterProvider>
    </DesignThemeProvider>
  );
}
