import {
  EmptyState,
  LinkButton,
} from "@hra-internal/design-kit/react";
import { NOINDEX_ROBOTS } from "@hraness/web-discovery";
import type { Metadata } from "next";

import { StandaloneThemeHeader } from "./standalone-theme-header";

export const metadata = {
  description: "This page does not exist.",
  robots: NOINDEX_ROBOTS,
  title: { absolute: "Not found · HRA" },
} satisfies Metadata;

export default function NotFound() {
  return (
    <main className="state-page" id="main-content">
      <StandaloneThemeHeader />
      <EmptyState
        action={<LinkButton href="/app" variant="primary">Open control plane</LinkButton>}
        className="state-card"
        description="The requested HRA surface does not exist or is no longer available."
        icon="404"
        title="Control-plane route not found"
      />
    </main>
  );
}
