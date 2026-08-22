import { colors } from "@hra-internal/design-kit";
import { parseConvexDeployment } from "@hra-internal/convex";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "@hraness/agent-tasks-ui/styles.css";
import { Providers } from "./providers";
import { hraRootMetadata } from "./site";
import { isWorkOSEnvironmentConfigured } from "./workos-configuration";

export const metadata = hraRootMetadata satisfies Metadata;
export const viewport = {
  colorScheme: "light dark",
  themeColor: [
    { color: colors.light.background, media: "(prefers-color-scheme: light)" },
    { color: colors.dark.background, media: "(prefers-color-scheme: dark)" },
  ],
} satisfies Viewport;

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
