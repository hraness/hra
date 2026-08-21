"use client";

import {
  Button,
  InlineAlert,
  PageIntro,
  SettingsCard,
} from "@hra-internal/design-kit/react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { StandaloneThemeHeader } from "./standalone-theme-header";

type AdminErrorBoundaryProps = Readonly<{ children: ReactNode }>;
type AdminErrorBoundaryState = Readonly<{ failed: boolean }>;

export class AdminErrorBoundary extends Component<
  AdminErrorBoundaryProps,
  AdminErrorBoundaryState
> {
  override state: AdminErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AdminErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep provider and transport details out of rendered output while retaining
    // a useful local development signal.
    console.error("HRA control plane render failed.", error.name, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="state-page" id="main-content">
        <StandaloneThemeHeader />
        <SettingsCard className="state-card" title="The live view could not be loaded.">
          <PageIntro eyebrow="Control plane unavailable" title="HRA" titleAs="h2" />
          <InlineAlert title="Subscription interrupted" tone="danger">
            Your session is still intact. Retry the subscriptions, or reload if the local backend
            was restarted.
          </InlineAlert>
          <div className="button-row">
            <Button onPress={() => this.setState({ failed: false })} variant="primary">
              Retry live view
            </Button>
            <Button onPress={() => window.location.reload()} variant="quiet">
              Reload page
            </Button>
          </div>
        </SettingsCard>
      </main>
    );
  }
}
