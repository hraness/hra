import { parseConvexDeployment } from "@hra-internal/convex";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import type { ReactNode } from "react";

import { PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE } from "../proxy-policy";
import { ConvexAuthBridge } from "./authenticated-providers";

export function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const deployment = parseConvexDeployment(process.env.NEXT_PUBLIC_CONVEX_URL);
  if (deployment.kind !== "ready") return children;
  return (
    <ConvexAuthNextjsServerProvider
      shouldHandleCode={PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE}
    >
      <ConvexAuthBridge url={deployment.url}>{children}</ConvexAuthBridge>
    </ConvexAuthNextjsServerProvider>
  );
}
