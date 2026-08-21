import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  isPathAtOrBelow,
  PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE,
  shouldApplyConfiguredAuthProxy,
} from "./proxy-policy";

export { shouldApplyConfiguredAuthProxy } from "./proxy-policy";

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
    const configured = process.env.NEXT_PUBLIC_CONVEX_URL?.trim() !== "" &&
      process.env.NEXT_PUBLIC_CONVEX_URL !== undefined;
    return configured && shouldApplyConfiguredAuthProxy(request.nextUrl.pathname)
      ? authProxy(request, event)
      : NextResponse.next();
  };
}

export default createHraProxy();

export const config = {
  // Next.js statically evaluates this export and does not resolve imported
  // constants here. Keep the literal aligned with AUTH_PROXY_MATCHER.
  matcher: ["/:path*"],
};
