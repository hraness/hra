import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { IconButton, IconLink } from "./ui";

import type {
  RuntimeDispatchResponse,
} from "../../contracts/runtime";
import { SubscriptionsSettings } from "./features/accounts/SubscriptionsSettings";
import { HRAIcon } from "./features/chat/Icon";
import { PaneGrid } from "./features/chat/PaneGrid";
import {
  chatRouteFromHash,
  chatRouteHash,
  createPaneCommand,
  createPaneId,
  paneRepositoriesEqual,
  paneIdsEqual,
  runtimeAvailabilityEqual,
  selectLastLocalPaneRepository,
  selectPaneIds,
  selectRuntimeAvailability,
  selectSubscriptionGate,
  type ChatRoute,
} from "./features/chat/model";
import {
  type RuntimeShell,
  useRuntimeShellSelector,
} from "./runtime";
import { useUiScale } from "./ui-scale";

export interface AppProps {
  /** StrictMode mounts must each own a fresh transport and shell lifecycle. */
  readonly runtimeShellFactory: () => RuntimeShell | null;
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
  return response.result.type === "chatPane"
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

export default function App({ runtimeShellFactory }: AppProps) {
  const shellRef = useRef<RuntimeShell | null>(null);
  const [runtimeShell, setRuntimeShell] = useState<RuntimeShell | null>(null);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const [route, setRoute] = useState<ChatRoute>(initialRoute);
  const [creatingPane, setCreatingPane] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
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
      </header>
      <main id="main-content" tabIndex={-1}>
        {creationError === null ? null : (
          <p className="creation-error" role="alert">{creationError}</p>
        )}
        {surface}
      </main>
    </div>
  );
}
