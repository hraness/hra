import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "@hraness/agent-tasks-ui/styles.css";
import { Providers } from "./providers";
import { hraRootMetadata } from "./site";

export const metadata = hraRootMetadata satisfies Metadata;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html data-theme="light" lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
