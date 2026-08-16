import { parseConvexDeployment } from "@hra-internal/convex";
import {
  InlineAlert,
  LinkButton,
  PageIntro,
  SettingsCard,
  ThemeToggle,
} from "@hra-internal/design-kit/react";
import { createPrivateSiteMetadata } from "@hra-internal/web-discovery";
import type { Metadata } from "next";

import { AdminControlPlane } from "../admin-shell";
import { hraSearchSite } from "../site";
import {
  missingWorkOSEnvironment,
} from "../workos-configuration";

export const metadata = createPrivateSiteMetadata({
  ...hraSearchSite,
  description: "The authenticated HRA human control plane.",
  title: "HRA control plane",
}) satisfies Metadata;

function ConfigurationState({
  detail,
  missing,
}: {
  detail: string;
  missing: readonly string[];
}) {
  return (
    <main className="state-page" id="main-content">
      <ThemeToggle className="standalone-theme-toggle" />
      <SettingsCard
        className="state-card state-card--configuration"
        description={detail}
        title="HRA is not connected yet."
      >
        <PageIntro eyebrow="Configuration required" title="Human control plane" titleAs="h2" />
        {missing.length > 0 ? (
          <div className="configuration-list">
            <p>Missing environment variables</p>
            <ul>
              {missing.map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <InlineAlert title="Server-only configuration">
          Configuration is read on the server. No provider credentials are exposed to this page.
        </InlineAlert>
        <div className="button-row">
          <LinkButton href="/download" variant="secondary">
            Download macOS Preview
          </LinkButton>
        </div>
      </SettingsCard>
    </main>
  );
}

export default function ControlPlanePage() {
  const missing = missingWorkOSEnvironment(process.env);
  const deployment = parseConvexDeployment(process.env.NEXT_PUBLIC_CONVEX_URL);

  if (missing.length > 0) {
    return (
      <ConfigurationState
        detail="Configure the local WorkOS session boundary before opening the human control plane."
        missing={missing}
      />
    );
  }

  if (deployment.kind === "missing") {
    return (
      <ConfigurationState
        detail="Start the local Convex deployment and provide its public origin."
        missing={["NEXT_PUBLIC_CONVEX_URL"]}
      />
    );
  }

  if (deployment.kind === "invalid") {
    return <ConfigurationState detail={deployment.message} missing={[]} />;
  }

  return <AdminControlPlane transport={deployment.transport} />;
}
