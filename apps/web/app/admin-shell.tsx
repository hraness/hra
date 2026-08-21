"use client";

import { createUuidV7 } from "@hraness/agent-tasks-protocol";
import { HranessBrand } from "@hra-internal/brand-ui";
import {
  AnimatedRailStage,
  AppShell,
  Avatar,
  Button,
  CheckboxField,
  DialogTrigger,
  EmptyState as DesignEmptyState,
  Icon,
  IconButton,
  InlineAlert,
  LinkButton,
  Modal,
  NavigationRail,
  PageIntro,
  PressableCard,
  RailItem,
  RailSection,
  SelectField,
  SettingsCard,
  SkipLink,
  Spinner,
  ThemeMenuButton,
  TopBar,
} from "@hra-internal/design-kit/react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { FunctionReturnType } from "convex/server";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api } from "../convex/_generated/api";
import { AdminErrorBoundary } from "./admin-error-boundary";
import {
  type WorkspaceRole,
  canonicalWorkspaceRoles,
  refreshedSelection,
  sameWorkspaceRoles,
  withWorkspaceRole,
  workspaceRoleValues,
} from "./admin-state";
import type { OrganizationOptionsResult } from "./organization-options";
import { Cancel01Icon } from "./hra-icon-data";
import { HRA_BRAND_ICON_PATH } from "./site";
import { StandaloneThemeHeader } from "./standalone-theme-header";
import { SuiteAccountControl } from "./suite-account-control";
import { ConvexTaskWorkspaceAdapter } from "./convex-task-workspace-adapter";

type ContextData = Extract<
  FunctionReturnType<typeof api.humanAdmin.currentContext>,
  { ok: true }
>["data"];
type WorkspacesData = Extract<
  FunctionReturnType<typeof api.humanAdmin.listWorkspaces>,
  { ok: true }
>["data"];
type MembersData = Extract<
  FunctionReturnType<typeof api.humanAdmin.listMembers>,
  { ok: true }
>["data"];
type AgentsData = Extract<
  FunctionReturnType<typeof api.humanAdmin.listAgents>,
  { ok: true }
>["data"];
type CredentialsData = Extract<
  FunctionReturnType<typeof api.humanAdmin.listAgentCredentials>,
  { ok: true }
>["data"];
type SessionsData = Extract<
  FunctionReturnType<typeof api.humanAdmin.listAgentSessions>,
  { ok: true }
>["data"];
type AgentClaimsData = Extract<
  FunctionReturnType<typeof api.humanTaskQueries.agentClaims>,
  { ok: true }
>["data"];

type Workspace = WorkspacesData["workspaces"][number];
type Member = MembersData["members"][number];
type Agent = AgentsData["agents"][number];
type Credential = CredentialsData["credentials"][number];
type AgentSession = SessionsData["sessions"][number];
type ActiveAgentClaim = AgentClaimsData["claims"][number];

type DomainError = Readonly<{
  code: string;
  requestId: string;
}>;

type ActionOutcome =
  | Readonly<{ kind: "success"; requestId: string }>
  | Readonly<{ error: DomainError; kind: "error" }>
  | Readonly<{ kind: "unavailable" }>;

type OrganizationOptionsState =
  | Readonly<{ kind: "idle" | "loading" }>
  | OrganizationOptionsResult;

type WorkspaceSurface = "access" | "tasks";

function controlPlaneHref(workspaceId: string, surface: WorkspaceSurface): string {
  const parameters = new URLSearchParams({ surface, workspace: workspaceId });
  return `/app?${parameters.toString()}`;
}

function idempotencyKey(): string {
  return createUuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
}

function isOrganizationAdministrator(role: string): boolean {
  return role === "owner" || role === "admin";
}

function errorCopy(code: string): string {
  switch (code) {
    case "AUTHENTICATION_FAILED":
    case "SESSION_INVALID":
    case "SESSION_REQUIRED":
      return "The human session is no longer valid. Sign in again before retrying.";
    case "AUTHORIZATION_DENIED":
    case "WORKSPACE_ROLE_REQUIRED":
      return "Your current organization role does not permit this operation.";
    case "MEMBERSHIP_INACTIVE":
      return "Your organization membership is no longer active.";
    case "NOT_FOUND":
      return "That record is no longer available in this workspace.";
    case "RATE_LIMITED":
      return "The control plane is busy. Wait briefly, then retry.";
    case "SERVICE_UNAVAILABLE":
      return "The local control plane is temporarily unavailable.";
    default:
      return "The operation could not be completed.";
  }
}

function DomainFailure({ error, title = "Could not load this view" }: { error: DomainError; title?: string }) {
  return (
    <div role="alert">
      <InlineAlert className="inline-state inline-state--error" title={title} tone="danger">
        <p>{errorCopy(error.code)}</p>
        <p className="support-reference">
          <span>{error.code}</span>
          <span aria-hidden="true">·</span>
          <span>Reference {error.requestId}</span>
        </p>
      </InlineAlert>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="inline-state" role="status">
      <Spinner aria-hidden="true" size="small" />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ children, title }: { children: ReactNode; title: string }) {
  return (
    <DesignEmptyState
      className="empty-state"
      description={children}
      icon="∅"
      title={title}
    />
  );
}

function EntityKind({ children, kind }: { children: ReactNode; kind: "human" | "agent" | "credential" | "session" }) {
  return <span className={`entity-kind entity-kind--${kind}`}>{children}</span>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-pill--${status.replaceAll("_", "-")}`}>{status.replaceAll("_", " ")}</span>;
}

function Timestamp({ value }: { value: number }) {
  if (!Number.isFinite(value)) return <span>Unknown</span>;
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)}
    </time>
  );
}

function ScopeList({ scopes }: { scopes: readonly string[] }) {
  return (
    <ul className="chip-list" aria-label="Granted scopes">
      {scopes.map((scope) => (
        <li key={scope}>{scope}</li>
      ))}
    </ul>
  );
}

function ResultLimitNotice({ cursor }: { cursor: string | null }) {
  if (cursor === null) return null;
  return (
    <p className="result-limit" role="note">
      This live view shows the first 100 records. Use <code>taskctl</code> for cursor-based export.
    </p>
  );
}

function ActionNotice({ outcome, success }: { outcome: ActionOutcome | null; success: string }) {
  if (outcome === null) return null;
  if (outcome.kind === "success") {
    return (
      <InlineAlert className="action-notice action-notice--success" isLive title="Command accepted" tone="success">
        {success} <span>Reference {outcome.requestId}</span>
      </InlineAlert>
    );
  }
  if (outcome.kind === "unavailable") {
    return (
      <div role="alert">
        <InlineAlert className="action-notice action-notice--error" title="Action not completed" tone="danger">
          The local control plane did not return a result. Retry with the same selection.
        </InlineAlert>
      </div>
    );
  }
  return <DomainFailure error={outcome.error} title="Action not completed" />;
}

function ConfirmAction({
  children,
  confirmLabel,
  description,
  disabled = false,
  onConfirm,
  onSuccess,
  title,
}: {
  children: ReactNode;
  confirmLabel: string;
  description: string;
  disabled?: boolean;
  onConfirm: (key: string) => Promise<ActionOutcome>;
  onSuccess: (outcome: Extract<ActionOutcome, { kind: "success" }>) => void;
  title: string;
}) {
  const keyRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionOutcome | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const changeOpen = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      keyRef.current ??= idempotencyKey();
      setFailure(null);
      setIsOpen(true);
      return;
    }
    if (busy) return;
    keyRef.current = null;
    setFailure(null);
    setIsOpen(false);
  }, [busy]);

  const confirm = useCallback(async () => {
    const key = keyRef.current ?? idempotencyKey();
    keyRef.current = key;
    setBusy(true);
    setFailure(null);
    const outcome = await onConfirm(key);
    setBusy(false);
    if (outcome.kind === "success") {
      keyRef.current = null;
      setFailure(null);
      setIsOpen(false);
      onSuccess(outcome);
      return;
    }
    setFailure(outcome);
  }, [onConfirm, onSuccess]);

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={changeOpen}>
      <Button
        isDisabled={disabled}
        size="compact"
        variant="danger"
      >
        {children}
      </Button>
      <Modal
        className="confirm-dialog"
        closeLabel="Close confirmation"
        description={description}
        isCloseDisabled={busy}
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
        surfaceClassName="confirm-dialog-surface"
        title={title}
      >
        {({ close }) => (
          <>
            <ActionNotice outcome={failure} success="" />
            <div className="button-row button-row--end">
              <Button
                autoFocus
                isDisabled={busy}
                onPress={close}
                variant="quiet"
              >
                Cancel
              </Button>
              <Button
                isDisabled={busy}
                isPending={busy}
                onPress={() => void confirm()}
                variant="danger"
              >
                {confirmLabel}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </DialogTrigger>
  );
}

function FullPageState({ children, eyebrow, title }: { children: ReactNode; eyebrow: string; title: string }) {
  return (
    <main className="state-page" id="main-content">
      <StandaloneThemeHeader />
      <SettingsCard className="state-card" title={title}>
        <PageIntro eyebrow={eyebrow} title="HRA" titleAs="h2" />
        {children}
      </SettingsCard>
    </main>
  );
}

function SignedOutState() {
  return (
    <FullPageState eyebrow="Human control plane" title="Supervision starts with a human session.">
      <p className="lede">
        Sign in to select an organization, inspect persistent agents, and manage
        their access.
      </p>
      <div className="button-row">
        <LinkButton href="/auth/sign-in" variant="primary">Sign in</LinkButton>
        <LinkButton href="/auth/sign-up" variant="quiet">Create account</LinkButton>
      </div>
      <p className="state-note">Agent credentials are enrolled separately through taskctl.</p>
    </FullPageState>
  );
}

function OrganizationRequired({
  error,
  options,
  onRetry,
  onSwitch,
}: {
  error: string | null;
  options: OrganizationOptionsState;
  onRetry: () => void;
  onSwitch: (organizationId: string, organizationName: string) => void;
}) {
  const organizations = options.kind === "ready" ? options.organizations : [];
  const [requestedSelection, setRequestedSelection] = useState<string | null>(null);
  const selection = refreshedSelection(
    requestedSelection,
    organizations.map(({ id }) => id),
  ) ?? "";

  return (
    <FullPageState eyebrow="Organization required" title="Choose where you are working.">
      <p className="lede">
        Your session is valid, but it is not scoped to an organization. Task data stays
        hidden until the session is switched.
      </p>
      {options.kind === "loading" || options.kind === "idle" ? <LoadingState label="Loading active memberships…" /> : null}
      {options.kind === "unavailable" ? (
        <div role="alert">
          <InlineAlert className="inline-state inline-state--error" title="Memberships could not be loaded" tone="danger">
            <p>The provider lookup is temporarily unavailable.</p>
            <Button
              onPress={onRetry}
              size="compact"
              variant="quiet"
            >
              Retry
            </Button>
          </InlineAlert>
        </div>
      ) : null}
      {options.kind === "signed-out" ? (
        <div role="alert">
          <InlineAlert className="inline-state inline-state--error" title="The server session has ended" tone="danger">
            <p>Reload this page to establish a new human session before choosing an organization.</p>
            <Button
              onPress={() => window.location.reload()}
              size="compact"
              variant="quiet"
            >
              Reload
            </Button>
          </InlineAlert>
        </div>
      ) : null}
      {options.kind === "ready" && organizations.length === 0 ? (
        <EmptyState title="No active organizations">
          Ask an organization administrator to add this human account, then retry.
        </EmptyState>
      ) : null}
      {organizations.length > 0 ? (
        <form
          className="organization-choice"
          onSubmit={(event) => {
            event.preventDefault();
            const selected = organizations.find(({ id }) => id === selection);
            if (selected !== undefined) onSwitch(selected.id, selected.name);
          }}
        >
          <SelectField
            className="organization-choice__field"
            id="initial-organization"
            label="Active organization"
            onChange={setRequestedSelection}
            options={organizations.map((organization) => ({
              id: organization.id,
              label: organization.name,
            }))}
            size="compact"
            value={selection}
          />
          <Button type="submit" variant="primary">
            Open control plane
          </Button>
        </form>
      ) : null}
      {error === null ? null : <div role="alert"><InlineAlert className="action-notice action-notice--error" tone="danger">{error}</InlineAlert></div>}
    </FullPageState>
  );
}

function OrganizationSwitcher({
  activeId,
  activeName,
  options,
  onRetry,
  onSwitch,
}: {
  activeId: string;
  activeName: string;
  options: OrganizationOptionsState;
  onRetry: () => void;
  onSwitch: (organizationId: string, organizationName: string) => void;
}) {
  const organizations = useMemo(() => {
    const available = options.kind === "ready" ? [...options.organizations] : [];
    if (!available.some(({ id }) => id === activeId)) available.unshift({ id: activeId, name: activeName });
    return available;
  }, [activeId, activeName, options]);

  if (options.kind === "unavailable") {
    return (
      <div className="organization-switcher organization-switcher--unavailable">
        <span>
          <small>Organization</small>
          <strong>{activeName}</strong>
        </span>
        <Button className="text-button" onPress={onRetry} size="compact" variant="quiet">
          Retry choices
        </Button>
      </div>
    );
  }

  return (
    <SelectField
      className="organization-switcher"
      disabled={options.kind !== "ready"}
      label="Organization"
      onChange={(organizationId) => {
        const selected = organizations.find(({ id }) => id === organizationId);
        if (selected !== undefined && selected.id !== activeId) onSwitch(selected.id, selected.name);
      }}
      options={organizations.map((organization) => ({
        id: organization.id,
        label: organization.name,
      }))}
      size="compact"
      value={activeId}
    />
  );
}

function WorkspaceNavigation({
  selectedId,
  surface,
  workspaces,
}: {
  selectedId: string;
  surface: WorkspaceSurface;
  workspaces: readonly Workspace[];
}) {
  return (
    <RailSection
      className="workspace-navigation"
      title={<>Workspaces <span className="rail-count">{workspaces.length}</span></>}
    >
      {workspaces.map((workspace) => (
        <RailItem
          href={controlPlaneHref(workspace.id, surface)}
          icon={<span className="workspace-mark">{workspace.taskKeyPrefix.slice(0, 2)}</span>}
          isActive={workspace.id === selectedId}
          key={workspace.id}
          label={workspace.name}
        />
      ))}
    </RailSection>
  );
}

function WorkspaceSurfaceNavigation({
  selectedId,
  surface,
}: Readonly<{
  selectedId: string;
  surface: WorkspaceSurface;
}>) {
  return (
    <RailSection title="Control plane">
      <RailItem
        href={controlPlaneHref(selectedId, "tasks")}
        isActive={surface === "tasks"}
        label="Tasks"
      />
      <RailItem
        href={controlPlaneHref(selectedId, "access")}
        isActive={surface === "access"}
        label="Access"
      />
    </RailSection>
  );
}

function MemberRoleEditor({ member, workspaceId }: { member: Member; workspaceId: string }) {
  const initialRoles = canonicalWorkspaceRoles(member.workspaceAccess.roles);
  const [roles, setRoles] = useState<readonly WorkspaceRole[]>(initialRoles);
  const [baselineRoles, setBaselineRoles] = useState<readonly WorkspaceRole[]>(initialRoles);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const keyRef = useRef<string | null>(null);
  const setWorkspaceRoles = useMutation(api.humanAdmin.setWorkspaceRoles);

  const changed = !sameWorkspaceRoles(roles, baselineRoles);
  const mutate = useCallback(async (key: string): Promise<ActionOutcome> => {
    try {
      const result = await setWorkspaceRoles({
        idempotencyKey: key,
        roles: [...roles],
        userId: member.id,
        workspaceId,
      });
      return result.ok
        ? { kind: "success", requestId: result.requestId }
        : { error: result.error, kind: "error" };
    } catch {
      return { kind: "unavailable" };
    }
  }, [member.id, roles, setWorkspaceRoles, workspaceId]);

  const save = useCallback(async () => {
    const key = keyRef.current ?? idempotencyKey();
    keyRef.current = key;
    setBusy(true);
    setOutcome(null);
    const result = await mutate(key);
    setBusy(false);
    setOutcome(result);
    if (result.kind === "success") {
      keyRef.current = null;
      setBaselineRoles(roles);
    }
  }, [mutate, roles]);

  const onRoleChange = (role: WorkspaceRole, checked: boolean) => {
    setRoles((current) => withWorkspaceRole(current, role, checked));
    keyRef.current = null;
    setOutcome(null);
  };

  return (
    <div className="member-row">
      <div className="member-identity">
        <EntityKind kind="human">Human</EntityKind>
        <strong>{member.name}</strong>
        <span>{member.email ?? "No email published"}</span>
        <small>Organization {member.organizationRole}</small>
      </div>
      <fieldset>
        <legend className="sr-only">Workspace roles for {member.name}</legend>
        {workspaceRoleValues.map((role) => (
          <CheckboxField
            checked={roles.includes(role)}
            className="role-toggle"
            disabled={busy}
            key={role}
            label={role}
            onChange={(event) => onRoleChange(role, event.target.checked)}
          />
        ))}
      </fieldset>
      <div className="member-action">
        {roles.length === 0 && changed ? (
          <ConfirmAction
            confirmLabel="Remove access"
            description={`${member.name} will lose this workspace assignment. Their organization membership is unchanged.`}
            disabled={busy}
            onConfirm={mutate}
            onSuccess={(result) => {
              setBaselineRoles(roles);
              setOutcome(result);
            }}
            title={`Remove ${member.name} from this workspace?`}
          >
            Remove access
          </ConfirmAction>
        ) : (
          <Button
            isDisabled={!changed || busy}
            isPending={busy}
            onPress={() => void save()}
            size="compact"
            variant="quiet"
          >
            Save roles
          </Button>
        )}
      </div>
      <ActionNotice outcome={outcome} success="Workspace access updated." />
    </div>
  );
}

function MemberManagement({ workspaceId }: { workspaceId: string }) {
  const result = useQuery(api.humanAdmin.listMembers, { limit: 100, workspaceId });
  if (result === undefined) return <LoadingState label="Loading human access…" />;
  if (!result.ok) return <DomainFailure error={result.error} title="Human access unavailable" />;
  if (result.data.members.length === 0) {
    return <EmptyState title="No organization members">No humans are available for workspace assignment.</EmptyState>;
  }
  return (
    <>
      <div className="member-list">
        {result.data.members.map((member: Member) => (
          <MemberRoleEditor
            key={`${member.id}:${member.workspaceAccess.status}:${member.workspaceAccess.roles.join(",")}`}
            member={member}
            workspaceId={workspaceId}
          />
        ))}
      </div>
      <ResultLimitNotice cursor={result.data.cursor} />
    </>
  );
}

function CredentialRow({
  agent,
  canManage,
  credential,
}: {
  agent: Agent;
  canManage: boolean;
  credential: Credential;
}) {
  const revokeCredential = useMutation(api.humanAdmin.revokeAgentCredential);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const revoke = useCallback(async (key: string): Promise<ActionOutcome> => {
    try {
      const result = await revokeCredential({
        agentId: agent.id,
        credentialId: credential.id,
        idempotencyKey: key,
        workspaceId: agent.workspaceId,
      });
      return result.ok
        ? { kind: "success", requestId: result.requestId }
        : { error: result.error, kind: "error" };
    } catch {
      return { kind: "unavailable" };
    }
  }, [agent.id, agent.workspaceId, credential.id, revokeCredential]);

  return (
    <li className="lifecycle-card">
      <div className="lifecycle-card__heading">
        <div>
          <EntityKind kind="credential">Credential</EntityKind>
          <code>{credential.id}</code>
        </div>
        <StatusPill status={credential.status} />
      </div>
      <ScopeList scopes={credential.scopes} />
      <dl className="fact-grid fact-grid--compact">
        <div><dt>Issued</dt><dd><Timestamp value={credential.createdAt} /></dd></div>
        <div><dt>Last used</dt><dd><Timestamp value={credential.lastUsedAt} /></dd></div>
        <div><dt>Expires</dt><dd><Timestamp value={credential.expiresAt} /></dd></div>
        {credential.status === "revoked" ? (
          <div><dt>Revoked</dt><dd><Timestamp value={credential.revokedAt} /></dd></div>
        ) : null}
      </dl>
      {!canManage || credential.status === "revoked" ? null : (
        <div className="lifecycle-card__action">
          <ConfirmAction
            confirmLabel="Revoke credential"
            description="This credential and every process session created from it will stop immediately. Other credentials for the persistent agent remain active."
            onConfirm={revoke}
            onSuccess={(result) => setOutcome(result)}
            title="Revoke this credential?"
          >
            Revoke
          </ConfirmAction>
        </div>
      )}
      <ActionNotice outcome={outcome} success="Credential revoked." />
    </li>
  );
}

function SessionRow({ session }: { session: AgentSession }) {
  return (
    <li className="lifecycle-card lifecycle-card--session">
      <div className="lifecycle-card__heading">
        <div>
          <EntityKind kind="session">Process session</EntityKind>
          <code>via {session.credentialId}</code>
        </div>
        <StatusPill status={session.status} />
      </div>
      <dl className="fact-grid fact-grid--compact">
        <div><dt>Started</dt><dd><Timestamp value={session.createdAt} /></dd></div>
        <div><dt>Last heartbeat</dt><dd><Timestamp value={session.lastSeenAt} /></dd></div>
        <div><dt>Idle deadline</dt><dd><Timestamp value={session.idleExpiresAt} /></dd></div>
      </dl>
    </li>
  );
}

function AgentClaimRow({ claim, now }: { claim: ActiveAgentClaim; now: number }) {
  return (
    <li className={`lifecycle-card lifecycle-card--claim${claim.expired ? " lifecycle-card--expired" : ""}`}>
      <div className="lifecycle-card__heading">
        <div>
          <EntityKind kind="agent">Execution claim</EntityKind>
          <strong>{claim.task.title}</strong>
          <code>{claim.task.key}</code>
        </div>
        <StatusPill status={claim.expired ? "expired" : "active"} />
      </div>
      <dl className="fact-grid fact-grid--compact">
        <div><dt>Lease deadline</dt><dd><Timestamp value={claim.leaseUntil} /></dd></div>
        <div><dt>Fence</dt><dd><code>{claim.fence}</code></dd></div>
        <div><dt>Lease generation</dt><dd><code>{claim.leaseGeneration}</code></dd></div>
      </dl>
      <p className="result-limit" role={claim.expired ? "alert" : "note"}>
        {claim.expired || claim.leaseUntil <= now
          ? "This lease is expired. Its fence is stale; refresh and reclaim before accepting process writes."
          : "The persistent agent owns this task until the lease deadline unless it releases or submits first."}
      </p>
    </li>
  );
}

function AgentLifecycle({ agent, canManage }: { agent: Agent; canManage: boolean }) {
  const credentials = useQuery(api.humanAdmin.listAgentCredentials, {
    agentId: agent.id,
    limit: 100,
    workspaceId: agent.workspaceId,
  });
  const sessions = useQuery(api.humanAdmin.listAgentSessions, {
    agentId: agent.id,
    limit: 100,
    workspaceId: agent.workspaceId,
  });
  const claims = useQuery(api.humanTaskQueries.agentClaims, {
    agentId: agent.id,
    limit: 100,
    workspaceId: agent.workspaceId,
  });
  const disableAgent = useMutation(api.humanAdmin.disableAgent);
  const [disableOutcome, setDisableOutcome] = useState<ActionOutcome | null>(null);

  const disable = useCallback(async (key: string): Promise<ActionOutcome> => {
    try {
      const result = await disableAgent({
        agentId: agent.id,
        idempotencyKey: key,
        workspaceId: agent.workspaceId,
      });
      return result.ok
        ? { kind: "success", requestId: result.requestId }
        : { error: result.error, kind: "error" };
    } catch {
      return { kind: "unavailable" };
    }
  }, [agent.id, agent.workspaceId, disableAgent]);

  return (
    <article className="agent-detail" aria-labelledby={`agent-${agent.id}`}>
      <header className="agent-detail__header">
        <div>
          <EntityKind kind="agent">Persistent agent</EntityKind>
          <h2 id={`agent-${agent.id}`}>{agent.name}</h2>
          <code>{agent.id}</code>
        </div>
        <div className="agent-detail__status">
          <StatusPill status={agent.status} />
          {canManage && agent.status === "active" ? (
            <ConfirmAction
              confirmLabel="Disable agent"
              description="The persistent agent kill switch immediately invalidates all of its credentials and process sessions. Tasks, claims, and history are preserved for audit."
              onConfirm={disable}
              onSuccess={(result) => setDisableOutcome(result)}
              title={`Disable ${agent.name}?`}
            >
              Disable agent
            </ConfirmAction>
          ) : null}
        </div>
      </header>
      <ActionNotice outcome={disableOutcome} success="Persistent agent disabled." />
      <div className="agent-detail__summary">
        <div>
          <span>Created</span>
          <strong><Timestamp value={agent.createdAt} /></strong>
        </div>
        <div>
          <span>Updated</span>
          <strong><Timestamp value={agent.updatedAt} /></strong>
        </div>
      </div>
      <ScopeList scopes={agent.scopes} />

      <section className="subsection" aria-labelledby={`credentials-${agent.id}`}>
        <div className="section-heading section-heading--compact">
          <div>
            <p className="eyebrow">Authentication material</p>
            <h3 id={`credentials-${agent.id}`}>Credentials</h3>
          </div>
          <p>Revocation is isolated to one credential.</p>
        </div>
        {credentials === undefined ? <LoadingState label="Loading credentials…" /> : null}
        {credentials !== undefined && !credentials.ok ? <DomainFailure error={credentials.error} title="Credentials unavailable" /> : null}
        {credentials?.ok && credentials.data.credentials.length === 0 ? (
          <EmptyState title="No credentials">This persistent agent has not redeemed an enrollment.</EmptyState>
        ) : null}
        {credentials?.ok && credentials.data.credentials.length > 0 ? (
          <>
            <ul className="lifecycle-list">
              {credentials.data.credentials.map((credential: Credential) => (
                <CredentialRow
                  agent={agent}
                  canManage={canManage}
                  credential={credential}
                  key={credential.id}
                />
              ))}
            </ul>
            <ResultLimitNotice cursor={credentials.data.cursor} />
          </>
        ) : null}
      </section>

      <section className="subsection" aria-labelledby={`sessions-${agent.id}`}>
        <div className="section-heading section-heading--compact">
          <div>
            <p className="eyebrow">Ephemeral runtime</p>
            <h3 id={`sessions-${agent.id}`}>Active sessions</h3>
          </div>
          <p>Process sessions expire after their idle deadline.</p>
        </div>
        {sessions === undefined ? <LoadingState label="Loading active process sessions…" /> : null}
        {sessions !== undefined && !sessions.ok ? <DomainFailure error={sessions.error} title="Sessions unavailable" /> : null}
        {sessions?.ok && sessions.data.sessions.length === 0 ? (
          <EmptyState title="No active sessions">No process is currently authenticated as this agent.</EmptyState>
        ) : null}
        {sessions?.ok && sessions.data.sessions.length > 0 ? (
          <>
            <ul className="lifecycle-list">
              {sessions.data.sessions.map((session: AgentSession) => (
                <SessionRow
                  key={`${session.credentialId}-${session.createdAt}-${session.lastSeenAt}`}
                  session={session}
                />
              ))}
            </ul>
            <ResultLimitNotice cursor={sessions.data.cursor} />
          </>
        ) : null}
      </section>

      <section className="subsection" aria-labelledby={`claims-${agent.id}`}>
        <div className="section-heading section-heading--compact">
          <div>
            <p className="eyebrow">Fenced work ownership</p>
            <h3 id={`claims-${agent.id}`}>Active claims</h3>
          </div>
          <p>Claims belong to this persistent agent; process sessions only carry its authority.</p>
        </div>
        {claims === undefined ? <LoadingState label="Loading active claims…" /> : null}
        {claims !== undefined && !claims.ok ? <DomainFailure error={claims.error} title="Claims unavailable" /> : null}
        {claims?.ok && claims.data.claims.length === 0 ? (
          <EmptyState title="No active claims">This agent does not currently own a fenced execution lease.</EmptyState>
        ) : null}
        {claims?.ok && claims.data.claims.length > 0 ? (
          <>
            <ul className="lifecycle-list">
              {claims.data.claims.map((claim: ActiveAgentClaim) => (
                <AgentClaimRow claim={claim} key={claim.id} now={claims.data.now} />
              ))}
            </ul>
            <ResultLimitNotice cursor={claims.data.cursor} />
          </>
        ) : null}
      </section>
    </article>
  );
}

function AgentDirectory({ canManage, workspaceId }: { canManage: boolean; workspaceId: string }) {
  const result = useQuery(api.humanAdmin.listAgents, { limit: 100, workspaceId });
  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);

  const agents = result?.ok ? result.data.agents : [];
  const selectedId = refreshedSelection(
    requestedAgentId,
    agents.map((agent: Agent) => agent.id),
  );

  if (result === undefined) return <LoadingState label="Loading persistent agents…" />;
  if (!result.ok) return <DomainFailure error={result.error} title="Agent directory unavailable" />;
  if (agents.length === 0) {
    return (
      <EmptyState title="No persistent agents">
        Issue an enrollment with <code>taskctl agent enrollment create</code>. The one-time secret is
        shown only in that trusted terminal.
      </EmptyState>
    );
  }

  const selected = agents.find((agent: Agent) => agent.id === selectedId) ?? agents[0];
  if (selected === undefined) return null;

  return (
    <div className="agent-directory">
      <ul className="agent-list" aria-label="Persistent agents">
        {agents.map((agent: Agent) => (
          <li key={agent.id}>
            <PressableCard
              aria-pressed={agent.id === selected.id}
              className="agent-list__item"
              onPress={() => setRequestedAgentId(agent.id)}
              tone={agent.id === selected.id ? "neutral" : "quiet"}
            >
              <span className="agent-glyph" aria-hidden="true">A</span>
              <span>
                <strong>{agent.name}</strong>
                <small>{agent.id}</small>
              </span>
              <StatusPill status={agent.status} />
            </PressableCard>
          </li>
        ))}
        {result.data.cursor === null ? null : (
          <li className="agent-list__limit">
            <ResultLimitNotice cursor={result.data.cursor} />
          </li>
        )}
      </ul>
      <AgentLifecycle agent={selected} canManage={canManage} key={selected.id} />
    </div>
  );
}

function WorkspacePanel({
  canManage,
  surface,
  workspace,
}: {
  canManage: boolean;
  surface: WorkspaceSurface;
  workspace: Workspace;
}) {
  return (
    <div className="workspace-panel">
      <PageIntro
        actions={<div className="workspace-role-summary">
          <span>Your workspace roles</span>
          {canManage ? <strong>Organization administrator</strong> : <ScopeList scopes={workspace.roles} />}
        </div>}
        className="workspace-header"
        description={<>Task keys begin with <code>{workspace.taskKeyPrefix}</code>. Live identity changes are reflected here without storing provider tokens in the browser.</>}
        eyebrow={`Workspace / ${workspace.slug}`}
        title={workspace.name}
      />

      {surface === "tasks" ? (
        <ConvexTaskWorkspaceAdapter workspaceId={workspace.id} />
      ) : (
        <div className="workspace-access-surface">
            <section className="panel-section" aria-labelledby="agents-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Identity lifecycle</p>
                  <h2 id="agents-heading">Agents</h2>
                </div>
                <p>Persistent identities own credentials; credentials authorize process sessions.</p>
              </div>
              <AgentDirectory canManage={canManage} workspaceId={workspace.id} />
            </section>

            <section className="panel-section" aria-labelledby="members-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Human supervision</p>
                  <h2 id="members-heading">Workspace access</h2>
                </div>
                <p>Organization membership and app-owned workspace roles remain separate.</p>
              </div>
              {canManage ? (
                <MemberManagement workspaceId={workspace.id} />
              ) : (
                <InlineAlert className="inline-state" title="Read-only access">
                  <p>Organization owners and administrators manage human workspace roles.</p>
                </InlineAlert>
              )}
            </section>
        </div>
      )}
    </div>
  );
}

function AuthorizedDashboard({
  activeOrganizationId,
  activeWorkspaceId,
  options,
  onRetryOrganizations,
  onSignOut,
  onSwitchOrganization,
  onSwitchWorkspace,
  transport,
}: {
  activeOrganizationId: string;
  activeWorkspaceId?: string;
  options: OrganizationOptionsState;
  onRetryOrganizations: () => void;
  onSignOut: () => void;
  onSwitchOrganization: (organizationId: string, organizationName: string) => void;
  onSwitchWorkspace: (workspaceId: string, workspaceName: string) => void;
  transport: "cloud" | "local";
}) {
  const contextResult = useQuery(api.humanAdmin.currentContext, {});
  const workspacesResult = useQuery(api.humanAdmin.listWorkspaces, { limit: 100 });
  const searchParams = useSearchParams();
  const requestedWorkspaceId = searchParams.get("workspace");
  const surface: WorkspaceSurface = searchParams.get("surface") === "access" ? "access" : "tasks";

  const workspaces = workspacesResult?.ok ? workspacesResult.data.workspaces : [];
  const selectedWorkspaceId = refreshedSelection(
    requestedWorkspaceId ?? activeWorkspaceId ?? null,
    workspaces.map((workspace: Workspace) => workspace.id),
  );
  const selectedWorkspace = workspaces.find(
    (workspace: Workspace) => workspace.id === selectedWorkspaceId,
  );
  const workspaceSelectionPending = selectedWorkspace !== undefined &&
    selectedWorkspace.id !== activeWorkspaceId;

  useEffect(() => {
    if (!workspaceSelectionPending || selectedWorkspace === undefined) return;
    onSwitchWorkspace(selectedWorkspace.id, selectedWorkspace.name);
  }, [onSwitchWorkspace, selectedWorkspace, workspaceSelectionPending]);

  if (contextResult === undefined || workspacesResult === undefined) {
    return (
      <FullPageState eyebrow="Live control plane" title="Opening your organization…">
        <LoadingState label="Authorizing workspace subscriptions…" />
      </FullPageState>
    );
  }
  if (!contextResult.ok) {
    return (
      <FullPageState eyebrow="Access interrupted" title="The organization context is unavailable.">
        <DomainFailure error={contextResult.error} />
      </FullPageState>
    );
  }
  if (!workspacesResult.ok) {
    return (
      <FullPageState eyebrow="Access interrupted" title="Workspaces could not be loaded.">
        <DomainFailure error={workspacesResult.error} />
      </FullPageState>
    );
  }

  const context: ContextData = contextResult.data;
  const canManage = isOrganizationAdministrator(context.organization.role);
  const navigationKey = `${selectedWorkspaceId ?? "empty"}:${surface}`;
  const rail = (
    <NavigationRail
      aria-label="HRA control plane"
      className="hra-navigation-rail"
      footer={(
        <div className="hra-rail-footer">
          <HranessBrand />
          <LinkButton href="/download" size="compact" variant="quiet">
            macOS Preview
          </LinkButton>
          <SuiteAccountControl />
          <div className="human-menu">
            <Avatar name={context.user.name} size="small" />
            <span>
              <EntityKind kind="human">Human</EntityKind>
              <strong>{context.user.name}</strong>
              <small>{context.user.email ?? context.organization.role}</small>
            </span>
            <Button className="text-button" onPress={onSignOut} size="compact" variant="quiet">
              Sign out
            </Button>
          </div>
        </div>
      )}
      header={(
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Image
              alt=""
              className="brand-icon-image"
              height={512}
              src={HRA_BRAND_ICON_PATH}
              width={512}
            />
          </span>
          <span>
            <strong>HRA</strong>
            <small>{transport === "local" ? "Local runtime" : "Cloud control plane"}</small>
          </span>
        </div>
      )}
    >
      <div className="hra-rail-stage">
        <WorkspaceNavigation
          selectedId={selectedWorkspace?.id ?? ""}
          surface={surface}
          workspaces={workspaces}
        />
        {selectedWorkspace === undefined ? null : (
          <WorkspaceSurfaceNavigation selectedId={selectedWorkspace.id} surface={surface} />
        )}
      </div>
    </NavigationRail>
  );

  return (
    <>
      <SkipLink href="#main-content">Skip to workspace</SkipLink>
      <AppShell
        className="hra-shell"
        mobileNavigationLabel="HRA control plane"
        navigationKey={navigationKey}
        openNavigationLabel="Open control-plane navigation"
        rail={rail}
        topBar={(
          <TopBar
            actions={<ThemeMenuButton />}
            className="topbar"
            leading={(
              <div className="topbar-route">
                <small>{selectedWorkspace?.name ?? context.organization.name}</small>
                <strong>{surface === "tasks" ? "Tasks" : "Access"}</strong>
              </div>
            )}
          >
            <OrganizationSwitcher
              activeId={activeOrganizationId}
              activeName={context.organization.name}
              onRetry={onRetryOrganizations}
              onSwitch={onSwitchOrganization}
              options={options}
            />
          </TopBar>
        )}
      >
        <main className={workspaces.length === 0 ? "shell-empty" : undefined} id="main-content" tabIndex={-1}>
          <AnimatedRailStage className="hra-main-stage" stageKey={navigationKey}>
            {workspaces.length === 0 ? (
              <EmptyState title="No accessible workspaces">
                Your organization membership is active, but no workspace has been assigned. An owner or
                administrator can add one with <code>taskctl workspace create</code> or grant you access.
              </EmptyState>
            ) : selectedWorkspace === undefined || workspaceSelectionPending ? (
              <LoadingState label="Selecting workspace…" />
            ) : (
              <WorkspacePanel
                canManage={canManage}
                key={`${selectedWorkspace.id}:${surface}`}
                surface={surface}
                workspace={selectedWorkspace}
              />
            )}
            <ResultLimitNotice cursor={workspacesResult.data.cursor} />
          </AnimatedRailStage>
        </main>
      </AppShell>
    </>
  );
}

export function AdminControlPlane({ transport }: { transport: "cloud" | "local" }) {
  const convexAuth = useConvexAuth();
  const { signOut } = useAuthActions();
  const scopes = useQuery(api.desktopPairing.accountScopes, {});
  const selectSession = useMutation(api.desktopPairing.selectSession);
  const [transition, setTransition] = useState<
    | null
    | Readonly<{ kind: "organization" | "workspace"; name: string }>
    | Readonly<{ kind: "sign-out" }>
  >(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const organizationOptions = useMemo<OrganizationOptionsState>(
    () => scopes === undefined
      ? { kind: "loading" }
      : scopes === null
        ? { kind: "signed-out" }
        : {
            kind: "ready",
            organizations: scopes.organizations.map(({ id, name }) => ({ id, name })),
          },
    [scopes],
  );
  const organizationId = scopes?.selectedOrganizationId;
  const workspaceId = scopes?.selectedWorkspaceId;
  const retryOrganizations = useCallback(() => window.location.reload(), []);

  const switchOrganization = useCallback(async (targetId: string, targetName: string) => {
    if (organizationOptions.kind !== "ready") return;
    const allowed = organizationOptions.organizations.some(({ id }) => id === targetId);
    if (!allowed) return;
    setSwitchError(null);
    setTransition({ kind: "organization", name: targetName });
    try {
      const result = await selectSession({ organizationId: targetId });
      if (result === null) throw new Error("organization switch rejected");
      window.location.replace("/app");
    } catch {
      setTransition(null);
      setSwitchError("The organization could not be opened. Your previous tenant remains active.");
    }
  }, [organizationOptions, selectSession]);

  const switchWorkspace = useCallback(async (targetId: string, targetName: string) => {
    if (organizationId === undefined) return;
    setSwitchError(null);
    setTransition({ kind: "workspace", name: targetName });
    try {
      const result = await selectSession({
        organizationId,
        workspaceId: targetId,
      });
      if (result?.workspace?.id !== targetId) throw new Error("workspace switch rejected");
      const currentSurface: WorkspaceSurface =
        new URL(window.location.href).searchParams.get("surface") === "access"
          ? "access"
          : "tasks";
      window.location.replace(controlPlaneHref(targetId, currentSurface));
    } catch {
      setTransition(null);
      setSwitchError("The workspace could not be opened. Your previous scope remains active.");
      window.history.replaceState(null, "", "/app");
    }
  }, [organizationId, selectSession]);

  const beginSignOut = useCallback(() => {
    setTransition({ kind: "sign-out" });
    void signOut().finally(() => window.location.replace("/"));
  }, [signOut]);

  if (convexAuth.isLoading || scopes === undefined) {
    return (
      <FullPageState eyebrow="Human authentication" title="Restoring your session…">
        <LoadingState label="Checking your HRA session…" />
      </FullPageState>
    );
  }
  if (!convexAuth.isAuthenticated || scopes === null) return <SignedOutState />;
  if (transition !== null) {
    const title = transition.kind === "sign-out"
      ? "Signing out…"
      : `Opening ${transition.name}…`;
    return (
      <FullPageState eyebrow="Tenant boundary" title={title}>
        <LoadingState label="The previous organization view is hidden while the session changes." />
      </FullPageState>
    );
  }
  if (organizationId === undefined) {
    return (
      <OrganizationRequired
        error={switchError}
        onRetry={retryOrganizations}
        onSwitch={(id, name) => void switchOrganization(id, name)}
        options={organizationOptions}
      />
    );
  }
  return (
    <AdminErrorBoundary>
      <AuthorizedDashboard
        activeOrganizationId={organizationId}
        {...(workspaceId === undefined ? {} : { activeWorkspaceId: workspaceId })}
        onRetryOrganizations={retryOrganizations}
        onSignOut={beginSignOut}
        onSwitchOrganization={(id, name) => void switchOrganization(id, name)}
        onSwitchWorkspace={(id, name) => void switchWorkspace(id, name)}
        options={organizationOptions}
        transport={transport}
      />
      {switchError === null ? null : (
        <div role="alert">
          <InlineAlert className="global-notice" title="Selection unchanged" tone="danger">
            <span>{switchError}</span>
            <IconButton
              aria-label="Dismiss"
              onPress={() => setSwitchError(null)}
              size="compact"
              tooltip="Dismiss"
            >
              <Icon icon={Cancel01Icon} />
            </IconButton>
          </InlineAlert>
        </div>
      )}
    </AdminErrorBoundary>
  );
}
