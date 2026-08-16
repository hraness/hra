import {
  EmptyState,
  LinkButton,
  ThemeToggle,
} from "@hra-internal/design-kit/react";

export default function NotFound() {
  return (
    <main className="state-page" id="main-content">
      <ThemeToggle className="standalone-theme-toggle" />
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
