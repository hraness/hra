import {
  DesignSystemGallery,
  ThemeMenuButton,
  TopBar,
} from "@hra-internal/design-kit/react";
import { NOINDEX_ROBOTS } from "@hraness/web-discovery";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Design system",
  description: "HRA's living browser design-system specification and responsive component stress lab.",
  robots: NOINDEX_ROBOTS,
};

export default function DesignPage() {
  return (
    <div className="design-page">
      <TopBar
        actions={<ThemeMenuButton />}
        aria-label="Design system controls"
      />
      <DesignSystemGallery />
    </div>
  );
}
