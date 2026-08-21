"use client";

import {
  Button,
  InlineAlert,
  PageIntro,
} from "@hra-internal/design-kit/react";

import { StandaloneThemeHeader } from "./standalone-theme-header";

export default function ErrorState({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <main className="state-page" id="main-content">
      <StandaloneThemeHeader />
      <section className="state-card" role="alert">
        <PageIntro
          description="Your session remains intact. Retry the current route without exposing provider details."
          eyebrow="Control plane unavailable"
          title="The live view could not be loaded."
        />
        <InlineAlert title="Subscription interrupted" tone="danger">
          HRA could not finish rendering this authorized view.
        </InlineAlert>
        <div className="button-row">
          <Button onPress={reset} variant="primary">Retry live view</Button>
          <Button onPress={() => window.location.reload()} variant="quiet">Reload page</Button>
        </div>
      </section>
    </main>
  );
}
