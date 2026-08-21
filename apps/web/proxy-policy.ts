import { isHraPublicComparisonPath } from "./app/alternatives/slugs";

export const AUTH_PROXY_MATCHER = ["/:path*"] as const;
export const PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE = false;

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

const AUTH_PROXY_EXCLUDED_PATH_TREES = ["/_next/static"] as const;

export function isPathAtOrBelow(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function shouldApplyConfiguredAuthProxy(pathname: string): boolean {
  return !AUTH_PROXY_EXCLUDED_EXACT_PATHS.has(pathname)
    && !isHraPublicComparisonPath(pathname)
    && !AUTH_PROXY_EXCLUDED_PATH_TREES.some((root) =>
      isPathAtOrBelow(pathname, root));
}
