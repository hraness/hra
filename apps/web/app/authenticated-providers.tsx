"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { type ReactNode, useMemo } from "react";

export function ConvexAuthBridge({ children, url }: { children: ReactNode; url: string }) {
  const client = useMemo(() => new ConvexReactClient(url), [url]);
  return <ConvexAuthNextjsProvider client={client}>{children}</ConvexAuthNextjsProvider>;
}
