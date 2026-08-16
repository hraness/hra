"use client";

import {
  isPrefetchableHref,
  RouterProvider,
  useLinkPrefetch,
} from "@hraness/ui";
import type { ReactNode } from "react";

export type DesignKitRouterOptions = Readonly<{
  scroll?: boolean;
}>;

declare module "@react-types/shared" {
  interface RouterConfig {
    routerOptions: DesignKitRouterOptions;
  }
}

export type DesignKitNavigate = (
  href: string,
  options: DesignKitRouterOptions | undefined,
) => void;

export type DesignKitPrefetch = (href: string) => void;

export type DesignKitRouterProviderProps = Readonly<{
  children: ReactNode;
  navigate: DesignKitNavigate;
  prefetch?: DesignKitPrefetch;
}>;

/**
 * Framework-neutral bridge from React Aria links to an application router.
 * Next apps bind this to `router.push` and may bind the optional performance
 * hint to `router.prefetch` without coupling the design kit to Next.js.
 */
export function DesignKitRouterProvider({
  children,
  navigate,
  prefetch,
}: DesignKitRouterProviderProps) {
  return (
    <RouterProvider
      navigate={navigate}
      {...(prefetch === undefined ? {} : { prefetch })}
    >
      {children}
    </RouterProvider>
  );
}

export function isPrefetchableAppHref(href: string | undefined): href is string {
  return isPrefetchableHref(href);
}

/** Prefetches each owned application href at most once per mounted link. */
export function useDesignKitLinkPrefetch(href: string | undefined): () => void {
  return useLinkPrefetch(href);
}
