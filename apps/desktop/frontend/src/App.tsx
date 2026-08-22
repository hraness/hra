import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Button, IconButton, IconLink } from "./ui";

import type {
  RuntimeDispatchResponse,
} from "../../contracts/runtime";
import { SubscriptionsSettings } from "./features/accounts/SubscriptionsSettings";
import { AttentionDrawer } from "./features/attention/AttentionDrawer";
import { HRAIcon } from "./features/chat/Icon";
import { PaneGrid } from "./features/chat/PaneGrid";
import {
  chatRouteFromHash,
  chatRouteHash,
  createPaneCommand,
  createPaneId,
  paneRepositoriesEqual,
  paneIdsEqual,
  executionEqual,
  runtimeAvailabilityEqual,
  selectExecution,
  selectLastLocalPaneRepository,
  selectPaneIds,
  selectRuntimeAvailability,
  selectSubscriptionGate,
  type ChatRoute,
} from "./features/chat/model";
import {
  type RuntimeShell,
  type RuntimeShellState,
  useRuntimeShellSelector,
} from "./runtime";
import { useUiScale } from "./ui-scale";

export interface AppProps {
  /** StrictMode mounts must each own a fresh transport and shell lifecycle. */
  readonly runtimeShellFactory: () => RuntimeShell | null;
  /** Optional serve-only chrome supplied by the development composition. */
  readonly headerAccessory?: ReactNode;
}

function initialRoute(): ChatRoute {
  return typeof window === "undefined"
    ? "panes"
    : chatRouteFromHash(window.location.hash);
}

export function focusMainContent(
  documentRoot: Pick<Document, "getElementById">,
): boolean {
  const target = documentRoot.getElementById("main-content");
  if (target === null) return false;
  target.focus({ preventScroll: true });
  return true;
}

function paneCreationError(response: RuntimeDispatchResponse): string | null {
  if (!response.ok) return response.error.message;
  return response.result.type === "chatPane" ||
      (response.result.type === "chatPaneReplay" &&
        response.result.commandType === "chat.pane.create")
    ? null
    : "The local runtime returned the wrong pane result.";
}

export function inheritedRepositoryIsUnavailable(
  response: RuntimeDispatchResponse,
): boolean {
  return !response.ok
    && response.error.code === "not_found"
    && response.error.message === "This repository is unavailable.";
}

export function selectAttentionRefreshKey(state: RuntimeShellState): string {
  const snapshot = state.state === "ready" || state.state === "reconnecting" ||
      state.state === "failed"
    ? state.snapshot
    : undefined;
  if (snapshot == null) return state.state;
  const syncStatus = snapshot.sessionSync.status;
  return JSON.stringify({
    shell: state.state,
    runtime: snapshot.runtime,
    runner: snapshot.runner,
    accounts: snapshot.accounts.map(({ id, revision }) => [id, revision]),
    folderAccessRevision: snapshot.execution.folderAccess.revision,
    humanAccountRevision: snapshot.humanAccount.revision,
    paneAttention: snapshot.chat.panes.map((pane) => ({
      id: pane.id,
      title: pane.title,
      repositoryName: pane.repository.name,
      workspaceRevision: pane.workspace?.revision ?? null,
      workspaceRecoveryKind: pane.workspace?.recoveryKind ?? null,
      attentionCode: pane.attention?.code ?? null,
      queuePauseReason: pane.messageQueue.pauseReason,
      blockedMessage: pane.messageQueue.blockedMessage !== null,
    })),
    sessionSync: syncStatus.state === "active"
      ? {
          state: syncStatus.state,
          revision: syncStatus.revision,
          health: syncStatus.health,
          recovery: syncStatus.recovery,
          pendingEnrollmentCount: syncStatus.pendingEnrollments.length,
          scheduledChatRecovery: syncStatus.scheduledChatRecovery?.state ?? null,
          remoteSessions: snapshot.sessionSync.remoteSessions.map(
            ({ sessionId, sourceRevision, state: remoteState }) => [
              sessionId,
              sourceRevision,
              remoteState,
            ],
          ),
        }
      : syncStatus,
  });
}

export default function App({ headerAccessory, runtimeShellFactory }: AppProps) {
  const shellRef = useRef<RuntimeShell | null>(null);
  const [runtimeShell, setRuntimeShell] = useState<RuntimeShell | null>(null);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const [route, setRoute] = useState<ChatRoute>(initialRoute);
  const [creatingPane, setCreatingPane] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [folderAccessError, setFolderAccessError] = useState<string | null>(null);
  useUiScale();
  const paneIds = useRuntimeShellSelector(runtimeShell, selectPaneIds, paneIdsEqual);
  const lastRepository = useRuntimeShellSelector(
    runtimeShell,
    selectLastLocalPaneRepository,
    paneRepositoriesEqual,
  );
  const subscriptionGate = useRuntimeShellSelector(runtimeShell, selectSubscriptionGate);
  const availability = useRuntimeShellSelector(
    runtimeShell,
    selectRuntimeAvailability,
    runtimeAvailabilityEqual,
  );
  const execution = useRuntimeShellSelector(
    runtimeShell,
    selectExecution,
    executionEqual,
  );
  const attentionRefreshKey = useRuntimeShellSelector(
    runtimeShell,
    selectAttentionRefreshKey,
  );

  useEffect(() => {
    const shell = runtimeShellFactory();
    if (shell === null) {
      setRuntimeShell(null);
      setNativeUnavailable(true);
      return;
    }
    shellRef.current = shell;
    setRuntimeShell(shell);
    setNativeUnavailable(false);
    void shell.connect();
    return () => {
      if (shellRef.current === shell) shellRef.current = null;
      setRuntimeShell((current) => current === shell ? null : current);
      shell.dispose();
    };
  }, [runtimeShellFactory]);

  useEffect(() => {
    const syncRoute = (): void => {
      const next = chatRouteFromHash(window.location.hash);
      const canonicalHash = chatRouteHash(next);
      if (window.location.hash !== canonicalHash) {
        window.history.replaceState(null, "", canonicalHash);
      }
      setRoute(next);
    };
    window.addEventListener("hashchange", syncRoute);
    syncRoute();
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  useEffect(() => {
    if (subscriptionGate !== "missing" || route === "settings") return;
    const settingsHash = chatRouteHash("settings");
    if (window.location.hash !== settingsHash) {
      window.history.replaceState(null, "", settingsHash);
    }
    setRoute("settings");
  }, [route, subscriptionGate]);

  const createPane = useCallback(async () => {
    const shell = shellRef.current;
    if (
      shell === null ||
      creatingPane ||
      paneIds.length >= 64 ||
      subscriptionGate !== "available" ||
      availability.kind !== "ready"
    ) return;
    setCreatingPane(true);
    setCreationError(null);
    try {
      const paneId = createPaneId();
      if (lastRepository !== null) {
        const response = await shell.dispatch(createPaneCommand({
          paneId,
          repositoryId: lastRepository.id,
        }));
        if (!inheritedRepositoryIsUnavailable(response)) {
          setCreationError(paneCreationError(response));
          return;
        }
      }
      const project = await shell.addProject();
      switch (project.status) {
        case "cancelled":
          return;
        case "failed":
          setCreationError(project.error.message);
          return;
        case "created": {
          const response = await shell.dispatch(createPaneCommand({
            paneId,
            repositoryId: project.repository.id,
          }));
          setCreationError(paneCreationError(response));
          return;
        }
      }
    } catch (reason: unknown) {
      setCreationError(
        reason instanceof Error
          ? reason.message
          : "The pane could not be created.",
      );
    } finally {
      setCreatingPane(false);
    }
  }, [availability.kind, creatingPane, lastRepository, paneIds.length, subscriptionGate]);

  const selectFolderAccess = useCallback(async () => {
    const shell = shellRef.current;
    if (shell === null || selectingFolder || availability.kind !== "ready") return;
    setSelectingFolder(true);
    setFolderAccessError(null);
    try {
      const result = await shell.selectFolderAccess();
      if (result.status === "failed") setFolderAccessError(result.error.message);
    } catch (reason: unknown) {
      setFolderAccessError(
        reason instanceof Error
          ? reason.message
          : "The shared folder could not be selected.",
      );
    } finally {
      setSelectingFolder(false);
    }
  }, [availability.kind, selectingFolder]);

  const skipToMain = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    focusMainContent(document);
  }, []);

  const effectiveRoute = subscriptionGate === "missing" ? "settings" : route;
  const surface = runtimeShell === null ? (
    <div aria-live="polite" className="runtime-startup">
      {nativeUnavailable
        ? "Open the native HRA app to use Codex and your local files."
        : "Starting HRA…"}
    </div>
  ) : effectiveRoute === "settings" ? (
    <>
      <h1 className="hra-visually-hidden">Settings</h1>
      <SubscriptionsSettings shell={runtimeShell} />
    </>
  ) : (
    <>
      <h1 className="hra-visually-hidden">Sessions</h1>
      <PaneGrid shell={runtimeShell} />
    </>
  );

  return (
    <div className="hra-app">
      <a className="hra-skip-link" href={chatRouteHash(effectiveRoute)} onClick={skipToMain}>
        Skip to content
      </a>
      <header className="hra-header">
        <span className="hra-visually-hidden">HRA</span>
        <nav aria-label="Main navigation" className="hra-nav">
          {effectiveRoute === "panes" ? (
            <IconLink
            aria-label="Settings"
            controlClassName="hra-nav__link"
            href="#settings"
            size="compact"
            tooltip="Settings"
          >
            <HRAIcon name="settings" />
          </IconLink>
          ) : subscriptionGate === "available" ? (
            <IconLink
              aria-label="Panes"
              controlClassName="hra-nav__link"
              href="#panes"
              size="compact"
              tooltip="Panes"
            >
              <HRAIcon name="panes" />
            </IconLink>
          ) : null}
        </nav>
        <Button
          {...(folderAccessError === null
            ? {}
            : { "aria-describedby": "folder-access-error" })}
          aria-label={`Shared folder access: ${execution.folderAccess.displayName}. Choose folder`}
          className="hra-folder-access-shell"
          controlClassName="hra-folder-access"
          data-availability={execution.folderAccess.availability}
          isDisabled={runtimeShell === null || availability.kind !== "ready" || selectingFolder}
          isPending={selectingFolder}
          leading={<HRAIcon name="folder" />}
          onPress={() => void selectFolderAccess()}
          size="compact"
          type="button"
          variant="quiet"
        >
          <span className="hra-folder-access__label">{execution.folderAccess.displayName}</span>
        </Button>
        <div className="hra-header__actions">
          {headerAccessory}
          <AttentionDrawer
            isAvailable={availability.kind === "ready"}
            refreshKey={attentionRefreshKey}
            shell={runtimeShell}
          />
          {effectiveRoute === "panes" ? (
            <IconButton
              aria-label={creatingPane ? "Choosing a project" : "New pane"}
              className="new-pane-button-shell"
              controlClassName="new-pane-button"
              isDisabled={
                runtimeShell === null ||
                availability.kind !== "ready" ||
                subscriptionGate !== "available" ||
                creatingPane ||
                paneIds.length >= 64
              }
              onPress={() => void createPane()}
              isPending={creatingPane}
              size="compact"
              type="button"
              variant="quiet"
            >
              <HRAIcon name="plus" />
            </IconButton>
          ) : <span className="hra-header__spacer" />}
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        {folderAccessError === null ? null : (
          <p className="creation-error" id="folder-access-error" role="alert">
            {folderAccessError}
          </p>
        )}
        {creationError === null ? null : (
          <p className="creation-error" role="alert">{creationError}</p>
        )}
        {surface}
      </main>
    </div>
  );
}
