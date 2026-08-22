import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  appendVaryAccept,
  NOT_ACCEPTABLE_BODY,
} from "./app/accept-negotiation";
import {
  isNextInternalNavigation,
  resolvePublicDiscovery,
} from "./app/public-markdown";
import {
  isPathAtOrBelow,
  PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE,
  shouldApplyConfiguredAuthProxy,
} from "./proxy-policy";
import { hraSecurityHeaders } from "./response-headers";

export { shouldApplyConfiguredAuthProxy } from "./proxy-policy";

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

const configuredProxy = convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    if (isPathAtOrBelow(request.nextUrl.pathname, "/app") &&
      !(await convexAuth.isAuthenticated())) {
      return nextjsMiddlewareRedirect(request, "/auth/sign-in?next=/app");
    }
    return NextResponse.next();
  },
  { shouldHandleCode: PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE },
);

type AuthProxy = (request: NextRequest, event: NextFetchEvent) => ReturnType<typeof configuredProxy>;

export function createHraProxy(authProxy: AuthProxy = configuredProxy) {
  return function hraProxy(request: NextRequest, event: NextFetchEvent) {
    const negotiated = publicDiscoveryResponse(request);
    if (negotiated !== null) return negotiated;
    if (!shouldApplyConfiguredAuthProxy(request.nextUrl.pathname)) {
      return NextResponse.next();
    }
    const configured = process.env.NEXT_PUBLIC_CONVEX_URL?.trim() !== "" &&
      process.env.NEXT_PUBLIC_CONVEX_URL !== undefined;
    return configured ? authProxy(request, event) : NextResponse.next();
  };
}

export default createHraProxy();

export const config = {
  // Next.js statically evaluates this export and does not resolve imported
  // constants here. Keep the literal aligned with AUTH_PROXY_MATCHER.
  matcher: ["/:path*"],
};
