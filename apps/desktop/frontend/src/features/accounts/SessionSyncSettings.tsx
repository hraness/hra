import { useCallback, useEffect, useRef, useState } from "react";

import { Button, IconButton, TextField } from "../../ui";

import {
  type RuntimeSessionSyncDomainCommand,
  runtimeSessionSyncCapabilities,
  type SessionSyncSnapshot,
  type SessionSyncStatusProjection,
} from "../../../../contracts/runtime";
import {
  type RuntimeShell,
  type RuntimeShellState,
  useRuntimeShellSelector,
} from "../../runtime";
import { HRAIcon } from "../chat/Icon";

const connectingSessionSync: SessionSyncSnapshot = {
  status: {
    state: "unavailable",
    reason: "serviceUnavailable",
    retryable: false,
  },
  localGridSlots: [],
  remoteSessions: [],
};

type SessionSyncAction =
  | "disable"
  | "enable"
  | "retry"
  | "reveal"
  | "saved";

type ActiveSessionSyncStatus = Extract<
  SessionSyncStatusProjection,
  { readonly state: "active" }
>;
type ScheduledChatRecoveryProjection =
  ActiveSessionSyncStatus["scheduledChatRecovery"];

export interface ScheduledChatOrphanActionView {
  readonly error: string | null;
  readonly pending: boolean;
}

interface ScopedScheduledChatOrphanAction extends ScheduledChatOrphanActionView {
  readonly attempt: number;
  readonly expectedRevision: number;
  readonly orphanId: string;
  readonly scope: string;
  readonly securityGeneration: number;
}

export interface RevealedRecoveryKit {
  readonly expiresAt: number;
  readonly revealId: string;
  readonly value: string;
}

export interface ScopedRecoverySecrets {
  readonly generation: number;
  readonly recoveryInput: string;
  readonly revealedKit: RevealedRecoveryKit | null;
  readonly scope: string;
}

export interface ScopedConfirmationId {
  readonly generation: number;
  readonly id: string;
  readonly scope: string;
}

function emptyRecoverySecrets(scope: string, generation: number): ScopedRecoverySecrets {
  return { generation, recoveryInput: "", revealedKit: null, scope };
}

export function nextSessionSyncSecurityGeneration(
  currentScope: string,
  currentGeneration: number,
  nextScope: string,
): number {
  return currentScope === nextScope ? currentGeneration : currentGeneration + 1;
}

export function recoverySecretsForSecurityBoundary(
  current: ScopedRecoverySecrets,
  scope: string,
  generation: number,
): ScopedRecoverySecrets {
  return current.scope === scope && current.generation === generation
    ? current
    : emptyRecoverySecrets(scope, generation);
}

export function confirmationIdForSecurityBoundary(
  current: ScopedConfirmationId | null,
  scope: string,
  generation: number,
): string | null {
  return current?.scope === scope && current.generation === generation
    ? current.id
    : null;
}

/**
 * The renderer never receives a vault coordinate. The current device ID is
 * vault-scoped, so it is the strongest renderer-safe boundary for plaintext
 * recovery state. Every non-active status is intentionally a distinct scope.
 */
export function sessionSyncSecurityScope(status: SessionSyncStatusProjection): string {
  switch (status.state) {
    case "active":
      return `active:${status.currentDeviceId}:${status.scopeGeneration}`;
    case "disabled":
      return `disabled:${status.deviceName}`;
    case "enrolling":
      return `enrolling:${status.deviceId}:${status.requestId}`;
    case "unavailable":
      return `unavailable:${status.reason}`;
  }
}

function selectSessionSync(state: RuntimeShellState): SessionSyncSnapshot {
  return state.state === "connecting"
    ? connectingSessionSync
    : state.snapshot?.sessionSync ?? connectingSessionSync;
}

function selectRuntimeReady(state: RuntimeShellState): boolean {
  return state.state === "ready";
}

function formatPairingCode(value: string): string {
  return `${value.slice(0, 3)} ${value.slice(3)}`;
}

function unavailableMessage(
  status: Extract<SessionSyncStatusProjection, { readonly state: "unavailable" }>,
): string {
  switch (status.reason) {
    case "cloudConfigurationMissing":
      return "Session sync is unavailable because this app has no cloud endpoint.";
    case "signedOut":
      return "Sign in to your HRA account to sync session summaries.";
    case "keychainUnavailable":
      return "Session sync cannot access this Mac’s secure key storage.";
    case "serviceUnavailable":
      return "Session sync is temporarily unavailable.";
    case "updateRequired":
      return "Update HRA before using session sync.";
  }
}

export function scheduledChatOrphanClearCommand(
  status: ActiveSessionSyncStatus,
  orphanId: string,
): RuntimeSessionSyncDomainCommand {
  if (
    status.scheduledChatRecovery === null
    || !status.scheduledChatRecovery.orphans.some(
      (orphan) => orphan.orphanId === orphanId,
    )
  ) {
    throw new RangeError("The scheduled-chat recovery item is no longer current.");
  }
  return {
    type: "sessionSync.scheduledChat.orphan.clear",
    expectedRevision: status.revision,
    orphanId,
  };
}

function scheduledChatRecoveryError(message: string): string {
  return message.replace(
    /syncscheduleorphan_[a-f0-9]{32}/gu,
    "this schedule",
  );
}

export function ScheduledChatRecoverySettings({
  actions,
  isDisabled,
  onRemove,
  recovery,
}: Readonly<{
  actions: ReadonlyMap<string, ScheduledChatOrphanActionView>;
  isDisabled: boolean;
  onRemove: (orphanId: string) => void;
  recovery: ScheduledChatRecoveryProjection;
}>) {
  if (recovery === null) return null;
  const hasPendingAction = [...actions.values()].some((action) => action.pending);

  return (
    <div className="session-sync-pending">
      <h3>Scheduled chat recovery</h3>
      <ul aria-label="Cloud schedules requiring recovery">
        {recovery.orphans.map((orphan, index) => {
          const action = actions.get(orphan.orphanId) ?? null;
          return (
            <li key={orphan.orphanId}>
              <div>
                <strong>Unavailable scheduled chat</strong>
                <span>
                  This cloud schedule belongs to newer chat state that is unavailable on this
                  Mac. Remove it before session sync can continue.
                </span>
                {action?.error === null || action?.error === undefined ? null : (
                  <span className="session-sync-warning" role="alert">
                    {action.error}
                  </span>
                )}
              </div>
              <Button
                aria-label={`Remove unavailable cloud schedule ${index + 1}`}
                isDisabled={isDisabled || (hasPendingAction && action?.pending !== true)}
                isPending={action?.pending === true}
                onPress={() => onRemove(orphan.orphanId)}
                size="compact"
                type="button"
                variant="secondary"
              >
                {action?.pending === true ? "Removing…" : "Remove schedule"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SessionSyncSettings({ shell }: { readonly shell: RuntimeShell }) {
  const snapshot = useRuntimeShellSelector(
    shell,
    selectSessionSync,
    Object.is,
  );
  const runtimeReady = useRuntimeShellSelector(
    shell,
    selectRuntimeReady,
    Object.is,
  );
  const [deviceName, setDeviceName] = useState("This Mac");
  const [pending, setPending] = useState<SessionSyncAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scheduledChatOrphanActions, setScheduledChatOrphanActions] = useState<
    readonly ScopedScheduledChatOrphanAction[]
  >([]);
  const scheduledChatOrphanActionsRef = useRef(scheduledChatOrphanActions);
  const scheduledChatOrphanAttemptRef = useRef(0);
  const status = snapshot.status;
  const statusRef = useRef(status);
  statusRef.current = status;
  const runtimeReadyRef = useRef(runtimeReady);
  runtimeReadyRef.current = runtimeReady;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const securityScope = sessionSyncSecurityScope(status);
  const securityScopeRef = useRef(securityScope);
  const securityGenerationRef = useRef(0);
  const [recoverySecrets, setRecoverySecrets] = useState<ScopedRecoverySecrets>(
    () => emptyRecoverySecrets(securityScope, securityGenerationRef.current),
  );
  const recoverySecretsRef = useRef(recoverySecrets);
  if (securityScopeRef.current !== securityScope) {
    securityGenerationRef.current = nextSessionSyncSecurityGeneration(
      securityScopeRef.current,
      securityGenerationRef.current,
      securityScope,
    );
    securityScopeRef.current = securityScope;
    recoverySecretsRef.current = emptyRecoverySecrets(
      securityScope,
      securityGenerationRef.current,
    );
  } else {
    recoverySecretsRef.current = recoverySecrets;
  }
  const scopedRecoverySecrets = recoverySecretsForSecurityBoundary(
    recoverySecrets,
    securityScope,
    securityGenerationRef.current,
  );
  const revealedKit = scopedRecoverySecrets.revealedKit;

  const publishScheduledChatOrphanActions = useCallback((
    update: (
      current: readonly ScopedScheduledChatOrphanAction[],
    ) => readonly ScopedScheduledChatOrphanAction[],
  ) => {
    const current = scheduledChatOrphanActionsRef.current;
    const next = update(current);
    if (next === current) return;
    scheduledChatOrphanActionsRef.current = next;
    if (securityScopeRef.current !== "unmounted") {
      setScheduledChatOrphanActions(next);
    }
  }, []);

  scheduledChatOrphanActionsRef.current = scheduledChatOrphanActions;
  const currentScheduledChatRecovery = status.state === "active"
    ? status.scheduledChatRecovery
    : null;
  const currentScheduledChatOrphanIds = new Set(
    currentScheduledChatRecovery?.orphans.map((orphan) => orphan.orphanId) ?? [],
  );
  const currentScheduledChatOrphanActions = new Map<string, ScheduledChatOrphanActionView>();
  if (status.state === "active") {
    for (const action of scheduledChatOrphanActions) {
      if (
        action.scope === securityScope
        && action.securityGeneration === securityGenerationRef.current
        && action.expectedRevision === status.revision
        && currentScheduledChatOrphanIds.has(action.orphanId)
      ) {
        currentScheduledChatOrphanActions.set(action.orphanId, action);
      }
    }
  }
  const scheduledChatOrphanMutationPending = [
    ...currentScheduledChatOrphanActions.values(),
  ].some((action) => action.pending);
  const mutationPending = pending !== null || scheduledChatOrphanMutationPending;

  const clearRecoverySecrets = useCallback(() => {
    const cleared = emptyRecoverySecrets(
      securityScopeRef.current,
      securityGenerationRef.current,
    );
    recoverySecretsRef.current = cleared;
    setRecoverySecrets(cleared);
  }, []);

  useEffect(() => {
    if (status.state === "disabled") setDeviceName(status.deviceName);
  }, [status]);

  useEffect(() => {
    if (
      recoverySecrets.scope === securityScope
      && recoverySecrets.generation === securityGenerationRef.current
    ) return;
    const cleared = emptyRecoverySecrets(
      securityScope,
      securityGenerationRef.current,
    );
    recoverySecretsRef.current = cleared;
    setRecoverySecrets(cleared);
  }, [recoverySecrets.generation, recoverySecrets.scope, securityScope]);

  useEffect(() => () => {
    securityScopeRef.current = "unmounted";
    securityGenerationRef.current += 1;
    scheduledChatOrphanActionsRef.current = [];
    recoverySecretsRef.current = emptyRecoverySecrets(
      "unmounted",
      securityGenerationRef.current,
    );
  }, []);

  useEffect(() => {
    if (revealedKit === null) return;
    const delay = Math.max(
      0,
      Math.min(60_000, revealedKit.expiresAt - Date.now()),
    );
    const revealId = revealedKit.revealId;
    const timeout = globalThis.setTimeout(() => {
      setRecoverySecrets((current) => current.scope === securityScopeRef.current
        && current.generation === securityGenerationRef.current
        && current.revealedKit?.revealId === revealId
        ? { ...current, revealedKit: null }
        : current);
    }, delay);
    return () => globalThis.clearTimeout(timeout);
  }, [revealedKit]);

  const run = useCallback(async (
    action: SessionSyncAction,
    command: RuntimeSessionSyncDomainCommand,
  ) => {
    const projected = statusRef.current;
    const scheduledChatMutationPendingNow = projected.state === "active"
      && scheduledChatOrphanActionsRef.current.some(
        (orphanAction) => orphanAction.pending
          && orphanAction.scope === securityScopeRef.current
          && orphanAction.securityGeneration === securityGenerationRef.current
          && orphanAction.expectedRevision === projected.revision,
      );
    if (pendingRef.current !== null || scheduledChatMutationPendingNow) return null;
    if (!runtimeReady) {
      setError("The local runtime is not ready.");
      return null;
    }
    const commandScope = securityScopeRef.current;
    const commandGeneration = securityGenerationRef.current;
    if (action === "disable") clearRecoverySecrets();
    pendingRef.current = action;
    setPending(action);
    setError(null);
    setNotice(null);
    try {
      const response = await shell.dispatch(command);
      if (!response.ok) {
        setError(response.error.message);
        return null;
      }
      if (response.result.type === "sessionSyncRecoveryKit") {
        if (
          securityScopeRef.current !== commandScope
          || securityGenerationRef.current !== commandGeneration
        ) return response.result;
        const revealed: RevealedRecoveryKit = {
          value: response.result.recoveryKit,
          expiresAt: response.result.expiresAt,
          revealId: response.result.revealId,
        };
        setRecoverySecrets((current) => current.scope === commandScope
          && current.generation === commandGeneration
          ? { ...current, revealedKit: revealed }
          : current);
      }
      return response.result;
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Session sync did not complete the request.",
      );
      return null;
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }, [
    clearRecoverySecrets,
    runtimeReady,
    shell,
  ]);

  const clearOrphanedScheduledChat = useCallback(async (orphanId: string) => {
    const currentStatus = statusRef.current;
    const commandScope = securityScopeRef.current;
    const commandGeneration = securityGenerationRef.current;
    if (
      currentStatus.state !== "active"
      || commandScope === "unmounted"
      || !runtimeReadyRef.current
      || pendingRef.current !== null
    ) return;

    let command: RuntimeSessionSyncDomainCommand;
    try {
      command = scheduledChatOrphanClearCommand(currentStatus, orphanId);
    } catch {
      return;
    }
    const expectedRevision = currentStatus.revision;
    const hasPendingAction = scheduledChatOrphanActionsRef.current.some(
      (action) => action.pending
        && action.scope === commandScope
        && action.securityGeneration === commandGeneration
        && action.expectedRevision === expectedRevision,
    );
    if (hasPendingAction) return;

    const attempt = scheduledChatOrphanAttemptRef.current + 1;
    scheduledChatOrphanAttemptRef.current = attempt;
    const pendingAction: ScopedScheduledChatOrphanAction = {
      attempt,
      error: null,
      expectedRevision,
      orphanId,
      pending: true,
      scope: commandScope,
      securityGeneration: commandGeneration,
    };
    publishScheduledChatOrphanActions((actions) => [
      ...actions.filter((action) => action.orphanId !== orphanId),
      pendingAction,
    ]);

    const actionIsCurrent = () => {
      const projected = statusRef.current;
      return securityScopeRef.current === commandScope
        && securityGenerationRef.current === commandGeneration
        && projected.state === "active"
        && projected.revision === expectedRevision
        && projected.scheduledChatRecovery?.orphans.some(
          (orphan) => orphan.orphanId === orphanId,
        ) === true;
    };
    const settle = (failure: string | null) => {
      publishScheduledChatOrphanActions((actions) => {
        const current = actions.find(
          (action) => action.orphanId === orphanId && action.attempt === attempt,
        );
        if (current === undefined) return actions;
        if (failure === null || !actionIsCurrent()) {
          return actions.filter((action) => action !== current);
        }
        return actions.map((action) => action === current
          ? { ...action, error: scheduledChatRecoveryError(failure), pending: false }
          : action);
      });
    };

    try {
      const response = await shell.dispatch(command);
      settle(response.ok ? null : response.error.message);
    } catch (reason: unknown) {
      settle(
        reason instanceof Error
          ? reason.message
          : "The cloud schedule could not be removed.",
      );
    }
  }, [publishScheduledChatOrphanActions, shell]);

  return (
    <section aria-labelledby="session-sync-title" className="settings-section session-sync-settings">
      <div className="settings-section__heading">
        <div>
          <h2 id="session-sync-title">Devices</h2>
        </div>
      </div>

      {status.state === "unavailable" ? (
        <div className="settings-note session-sync-unavailable" role="status">
          <span>{unavailableMessage(status)}</span>
          {status.retryable ? (
            <IconButton
              aria-label="Retry session sync"
              isDisabled={!runtimeReady || mutationPending}
              isPending={pending === "retry"}
              onPress={() => void run("retry", { type: "sessionSync.retry" })}
              size="compact"
              tooltip="Retry session sync"
              type="button"
              variant="quiet"
            >
              <HRAIcon name="refresh" />
            </IconButton>
          ) : null}
        </div>
      ) : status.state === "disabled" ? (
        <div className="session-sync-enable">
          <TextField
            inputProps={{
              autoComplete: "off",
              maxLength: 80,
              spellCheck: false,
            }}
            label="This device"
            onChange={setDeviceName}
            value={deviceName}
          />
          <Button
            isDisabled={
              !runtimeReady
              || mutationPending
              || deviceName.trim().length === 0
            }
            onPress={() => void run("enable", {
              type: "sessionSync.enable",
              expectedRevision: status.revision,
              deviceName: deviceName.trim(),
            })}
            size="compact"
            type="button"
            variant="primary"
          >
            {pending === "enable" ? "Enabling…" : "Enable encrypted sync"}
          </Button>
        </div>
      ) : status.state === "enrolling" ? (
        <div className="session-sync-enrolling" role="status">
          <div>
            <strong>{status.deviceName}</strong>
            <span>
              {status.phase === "awaitingApproval"
                ? "Waiting for approval on another device"
                : "Finishing approval"}
            </span>
            <code aria-label="Pairing code to compare on the approving Mac">
              {formatPairingCode(status.pairingCode)}
            </code>
          </div>
          <div className="session-sync-actions">
            {status.retryable ? (
              <IconButton
                aria-label="Retry device enrollment"
                isDisabled={!runtimeReady || mutationPending}
                isPending={pending === "retry"}
                onPress={() => void run("retry", { type: "sessionSync.retry" })}
                size="compact"
                tooltip="Retry device enrollment"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="refresh" />
              </IconButton>
            ) : null}
            <IconButton
              aria-label="Turn off session sync"
              isDisabled={!runtimeReady || mutationPending}
              isPending={pending === "disable"}
              onPress={() => void run("disable", {
                type: "sessionSync.disable",
                expectedRevision: status.revision,
              })}
              size="compact"
              tooltip="Turn off session sync"
              type="button"
              variant="quiet"
            >
              <HRAIcon name="power" />
            </IconButton>
          </div>
        </div>
      ) : (
        <>
          {status.notice === null ? null : (
            <p className="settings-note" role="status">{status.notice}</p>
          )}
          <ul aria-label="Approved devices" className="session-sync-device-list">
            {status.devices.map((device) => (
              <li
                aria-label={`${device.name}${device.current ? ", current device" : ""}`}
                key={device.id}
              >
                <div>
                  <strong>{device.name}</strong>
                  {device.status === "revoked"
                    ? <span>Revoked</span>
                    : device.connection === "offline"
                      ? <span>Offline</span>
                      : device.connection === "unknown"
                        ? <span>Connection unknown</span>
                        : null}
                </div>
              </li>
            ))}
          </ul>
          {!runtimeSessionSyncCapabilities.enrollmentApproval
            || !runtimeSessionSyncCapabilities.deviceRevocation ? (
              <p className="settings-note">
                Device approval and revocation are unavailable in this build.
              </p>
            ) : null}

          {status.pendingEnrollments.length === 0 ? null : (
            <div className="session-sync-pending">
              <h3>Waiting for approval</h3>
              <ul>
                {status.pendingEnrollments.map((enrollment) => (
                  <li key={enrollment.requestId}>
                    <div>
                      <strong>{enrollment.name}</strong>
                      <code aria-label={`Pairing code for ${enrollment.name}`}>
                        {formatPairingCode(enrollment.pairingCode)}
                      </code>
                    </div>
                    {!runtimeSessionSyncCapabilities.enrollmentApproval ? (
                      <span>Approval is unavailable in this build.</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ScheduledChatRecoverySettings
            actions={currentScheduledChatOrphanActions}
            isDisabled={!runtimeReady || mutationPending}
            onRemove={(orphanId) => void clearOrphanedScheduledChat(orphanId)}
            recovery={status.scheduledChatRecovery}
          />

          <div className="session-sync-recovery">
            <div>
              <h3>Recovery kit</h3>
              {status.recovery === "exportRequired" ? (
                <p>Reveal and store this kit offline before relying on synced recovery.</p>
              ) : null}
            </div>
            <div aria-label="Recovery kit actions" className="session-sync-actions" role="group">
              <IconButton
                aria-label="Reveal recovery kit"
                isDisabled={!runtimeReady || mutationPending}
                isPending={pending === "reveal"}
                onPress={() => void run("reveal", {
                  type: "sessionSync.recovery.reveal",
                  expectedRevision: status.revision,
                })}
                size="compact"
                tooltip="Reveal recovery kit"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="eye" />
              </IconButton>
            </div>
            {!runtimeSessionSyncCapabilities.recoveryImport ? (
              <p className="settings-note">
                Recovery import and rotation are unavailable in this build.
              </p>
            ) : null}
            {revealedKit === null ? null : (
              <div className="session-sync-recovery__revealed">
                <pre aria-label="Recovery kit">{revealedKit.value}</pre>
                <div className="session-sync-actions">
                  <Button
                    isDisabled={!runtimeReady || mutationPending}
                    isPending={pending === "saved"}
                    onPress={() => void (async () => {
                      const result = await run("saved", {
                        type: "sessionSync.recoveryKitSavedOffline",
                        expectedRevision: status.revision,
                        revealId: revealedKit.revealId,
                      });
                      if (result !== null) {
                        setRecoverySecrets((current) => current.scope === securityScopeRef.current
                          && current.generation === securityGenerationRef.current
                          && current.revealedKit?.revealId === revealedKit.revealId
                          ? { ...current, revealedKit: null }
                          : current);
                        setNotice("Recovery kit marked as saved offline.");
                      }
                    })()}
                    size="compact"
                    type="button"
                    variant="primary"
                  >
                    Saved offline
                  </Button>
                  <IconButton
                    aria-label="Hide recovery kit"
                    onPress={() => setRecoverySecrets((current) => (
                      current.scope === securityScopeRef.current
                        && current.generation === securityGenerationRef.current
                        ? { ...current, revealedKit: null }
                        : current
                    ))}
                    size="compact"
                    tooltip="Hide recovery kit"
                    type="button"
                    variant="quiet"
                  >
                    <HRAIcon name="close" />
                  </IconButton>
                </div>
              </div>
            )}
          </div>

          <div className="session-sync-footer-actions">
            {status.retryable ? (
              <IconButton
                aria-label="Retry session sync"
                isDisabled={!runtimeReady || mutationPending}
                isPending={pending === "retry"}
                onPress={() => void run("retry", { type: "sessionSync.retry" })}
                size="compact"
                tooltip="Retry session sync"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="refresh" />
              </IconButton>
            ) : null}
            <IconButton
              aria-label="Turn off session sync"
              isDisabled={!runtimeReady || mutationPending}
              isPending={pending === "disable"}
              onPress={() => void run("disable", {
                type: "sessionSync.disable",
                expectedRevision: status.revision,
              })}
              size="compact"
              tooltip="Turn off session sync"
              type="button"
              variant="quiet"
            >
              <HRAIcon name="power" />
            </IconButton>
          </div>
        </>
      )}

      {error === null ? null : (
        <p className="settings-error" role="alert">{error}</p>
      )}
      {notice === null ? null : (
        <p className="settings-note" role="status">{notice}</p>
      )}
    </section>
  );
}
