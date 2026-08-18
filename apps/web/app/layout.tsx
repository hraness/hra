import { parseConvexDeployment } from "@hra-internal/convex";
import { createPublicSiteMetadata } from "@hraness/web-discovery";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "@hraness/agent-tasks-ui/styles.css";
import { Providers } from "./providers";
import { hraSearchSite } from "./site";
import { isWorkOSEnvironmentConfigured } from "./workos-configuration";

export const metadata = {
  ...createPublicSiteMetadata(hraSearchSite),
  keywords: [
    "Codex metaharness",
    "multiple Codex accounts",
    "Codex orchestration",
    "coding agents",
    "parallel agents",
    "human in the loop",
    "AI task orchestration",
    "local-first developer tools",
  ],
} satisfies Metadata;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const authConfigured = isWorkOSEnvironmentConfigured(process.env);
  const deployment = parseConvexDeployment(process.env.NEXT_PUBLIC_CONVEX_URL);
  return (
    <html data-theme="light" lang="en" suppressHydrationWarning>
      <body>
        <Providers
          authConfigured={authConfigured}
          deployment={deployment}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
