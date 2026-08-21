import { parseConvexDeployment } from "@hra-internal/convex";
import { InlineAlert, PageIntro, SettingsCard } from "@hra-internal/design-kit/react";

export function convexAuthIsConfigured(): boolean {
  return parseConvexDeployment(process.env.NEXT_PUBLIC_CONVEX_URL).kind === "ready";
}

export function AuthConfigurationUnavailable() {
  return (
    <main className="state-page" id="main-content">
      <SettingsCard className="state-card" title="Authentication unavailable">
        <PageIntro
          eyebrow="HRA configuration"
          title="This environment is not connected to Convex Auth"
          titleAs="h2"
        />
        <InlineAlert tone="danger">
          Configure a valid NEXT_PUBLIC_CONVEX_URL, then restart the web app.
        </InlineAlert>
      </SettingsCard>
    </main>
  );
}
