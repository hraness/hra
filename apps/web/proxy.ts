import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { isHraPublicComparisonPath } from "./app/alternatives/slugs";
import { isWorkOSEnvironmentConfigured } from "./app/workos-configuration";

const configuredProxy = authkitProxy();

const AUTH_PROXY_EXCLUDED_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/_next/image",
  "/apple-icon",
  "/apple-icon.png",
  "/download",
  "/download/",
  "/favicon.ico",
  "/icon",
  "/icon.png",
  "/opengraph-image",
  "/robots.txt",
  "/sitemap.xml",
]);

const AUTH_PROXY_EXCLUDED_PATH_TREES = [
  "/_next/static",
] as const;

function isPathAtOrBelow(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function shouldApplyConfiguredAuthProxy(pathname: string): boolean {
  return !AUTH_PROXY_EXCLUDED_EXACT_PATHS.has(pathname)
    && !isHraPublicComparisonPath(pathname)
    && !AUTH_PROXY_EXCLUDED_PATH_TREES.some((root) =>
      isPathAtOrBelow(pathname, root));
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!shouldApplyConfiguredAuthProxy(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const configured = isWorkOSEnvironmentConfigured(process.env);
  return configured ? configuredProxy(request, event) : NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
