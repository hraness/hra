"use client";

import { Button, InlineAlert, LinkButton, PageIntro, SettingsCard } from "@hra-internal/design-kit/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useMemo, useState, type ReactNode } from "react";

import { api } from "../../../../convex/_generated/api";

export function DesktopPairingApproval({ pairingId }: { pairingId: string }) {
  const auth = useConvexAuth();
  const context = useQuery(api.desktopPairing.approvalContext, { pairingId });
  const approve = useMutation(api.desktopPairing.approve);
  const deny = useMutation(api.desktopPairing.deny);
  const [organizationId, setOrganizationId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedOrganizationId = organizationId || context?.organizations[0]?.organization.id || "";
  const selectedOrganization = context?.organizations.find(({ organization }) =>
    organization.id === selectedOrganizationId);
  const workspaces = useMemo(
    () => selectedOrganization?.workspaces ?? [],
    [selectedOrganization],
  );
  const workspacesComplete = selectedOrganization?.workspacesComplete ?? true;
  const selectedWorkspaceId = workspaces.some(({ id }) => id === workspaceId)
    ? workspaceId
    : workspaces[0]?.id ?? "";

  if (auth.isLoading) {
    return <PairingCard title="Restoring your session…"><p>Checking your HRA account.</p></PairingCard>;
  }
  if (!auth.isAuthenticated) {
    const next = `/pair/desktop/${pairingId}`;
    return (
      <PairingCard title="Sign in to pair this desktop">
        <p>The desktop receives access only after you authenticate and choose an exact workspace.</p>
        <LinkButton href={`/auth/sign-in?next=${encodeURIComponent(next)}`} variant="primary">Sign in</LinkButton>
      </PairingCard>
    );
  }
  if (context === undefined) {
    return <PairingCard title="Loading pairing request…"><p>Checking its current state.</p></PairingCard>;
  }
  if (context === null) {
    const next = `/pair/desktop/${pairingId}`;
    return (
      <PairingCard title="Sign in again to pair this desktop">
        <p>Desktop approval requires a recent password sign-in.</p>
        <LinkButton href={`/auth/sign-in?next=${encodeURIComponent(next)}`} variant="primary">
          Sign in again
        </LinkButton>
      </PairingCard>
    );
  }
  if (context.status !== "pending") {
    const copy = context.status === "approved"
      ? "Approval recorded. Return to the desktop while it finishes pairing."
      : context.status === "consumed"
        ? "This one-time pairing request has already connected a desktop."
        : context.status === "denied"
          ? "This pairing request was denied."
          : "This pairing request expired. Start a new pairing from the desktop.";
    return <PairingCard title="Desktop pairing"><InlineAlert>{copy}</InlineAlert></PairingCard>;
  }

  const submitApproval = async () => {
    if (selectedOrganizationId === "" || selectedWorkspaceId === "") return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await approve({
        pairingId,
        organizationId: selectedOrganizationId,
        workspaceId: selectedWorkspaceId,
      });
      if (!accepted) throw new Error("approval rejected");
    } catch {
      setError("The request changed before approval. Start a new pairing if it has expired.");
      setBusy(false);
    }
  };

  const submitDenial = async () => {
    setBusy(true);
    setError(null);
    try {
      const accepted = await deny({ pairingId });
      if (!accepted) throw new Error("denial rejected");
    } catch {
      setError("The request changed before it could be denied.");
      setBusy(false);
    }
  };

  return (
    <PairingCard title="Approve desktop access">
      <p>Compare this code with the one shown by the desktop. Deny the request if they differ.</p>
      <output className="pairing-code" aria-label="Desktop pairing comparison code">
        {context.comparisonCode}
      </output>
      {context.organizations.length === 0 ? (
        <InlineAlert tone="danger">No active organization is available for this account.</InlineAlert>
      ) : !workspacesComplete ? (
        <InlineAlert tone="danger">
          This organization has too many workspaces to show safely. Ask an administrator to reduce
          the active workspace count before pairing this desktop.
        </InlineAlert>
      ) : (
        <div className="pairing-selection">
          <label>
            <span>Organization</span>
            <select
              onChange={(event) => {
                setOrganizationId(event.target.value);
                setWorkspaceId("");
              }}
              value={selectedOrganizationId}
            >
              {context.organizations.map(({ organization }) => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Workspace</span>
            <select onChange={(event) => setWorkspaceId(event.target.value)} value={selectedWorkspaceId}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error === null ? null : <InlineAlert tone="danger">{error}</InlineAlert>}
      <div className="button-row">
        <Button
          isDisabled={busy || !workspacesComplete || selectedWorkspaceId === ""}
          isPending={busy}
          onPress={() => void submitApproval()}
          variant="primary"
        >
          Approve desktop
        </Button>
        <Button
          isDisabled={busy}
          onPress={() => void submitDenial()}
          variant="quiet"
        >
          Deny
        </Button>
      </div>
    </PairingCard>
  );
}

function PairingCard({ children, title }: { children: ReactNode; title: string }) {
  return (
    <main className="state-page" id="main-content">
      <SettingsCard className="state-card" title={title}>
        <PageIntro eyebrow="One-time desktop pairing" title="HRA" titleAs="h2" />
        {children}
      </SettingsCard>
    </main>
  );
}
