import { colors } from "@hra-internal/design-kit";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "@hraness/agent-tasks-ui/styles.css";
import { Providers } from "./providers";
import { hraRootMetadata } from "./site";

export const metadata = hraRootMetadata satisfies Metadata;
export const viewport = {
  colorScheme: "light dark",
  themeColor: [
    { color: colors.light.background, media: "(prefers-color-scheme: light)" },
    { color: colors.dark.background, media: "(prefers-color-scheme: dark)" },
  ],
} satisfies Viewport;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html data-theme="light" lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
