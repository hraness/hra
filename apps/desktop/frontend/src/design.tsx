import "@hra-internal/design-kit/styles.css";
import { DesignSystemGallery } from "@hra-internal/design-kit/react";

/** Side-effect-free browser specification route; it never opens the native bridge. */
export default function DesignPage() {
  return <DesignSystemGallery />;
}
