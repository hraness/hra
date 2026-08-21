import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  appendVaryAccept,
  NOT_ACCEPTABLE_BODY,
} from "./app/accept-negotiation";
import { isHraPublicComparisonPath } from "./app/alternatives/slugs";
import {
  isNextInternalNavigation,
  resolvePublicDiscovery,
} from "./app/public-markdown";
import { isWorkOSEnvironmentConfigured } from "./app/workos-configuration";
import { hraSecurityHeaders } from "./response-headers";

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
  "/llms.txt",
  "/llms.txt/",
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

function withHraSecurityHeaders(headers: Headers): Headers {
  for (const header of hraSecurityHeaders) {
    if (!headers.has(header.key)) headers.set(header.key, header.value);
  }
  return headers;
}

function publicDiscoveryResponse(
  request: NextRequest,
): NextResponse | null {
  const decision = resolvePublicDiscovery({
    accept: request.headers.get("accept"),
    method: request.method,
    nextInternalNavigation: isNextInternalNavigation(request.headers),
    pathname: request.nextUrl.pathname,
  });
  if (decision.action === "passthrough") return null;
  if (decision.action === "html") {
    const response = NextResponse.next();
    appendVaryAccept(response.headers);
    return response;
  }

  const headers = withHraSecurityHeaders(new Headers());
  appendVaryAccept(headers);
  const head = request.method.toUpperCase() === "HEAD";
  if (decision.action === "not_acceptable") {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new NextResponse(head ? null : NOT_ACCEPTABLE_BODY, {
      headers,
      status: 406,
    });
  }
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("Content-Type", decision.contentType);
  return new NextResponse(head ? null : decision.body, {
    headers,
    status: decision.status,
  });
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const negotiated = publicDiscoveryResponse(request);
  if (negotiated !== null) return negotiated;
  if (!shouldApplyConfiguredAuthProxy(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const configured = isWorkOSEnvironmentConfigured(process.env);
  return configured ? configuredProxy(request, event) : NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
