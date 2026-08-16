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
  const status = snapshot.status;
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
    if (pending !== null) return null;
    if (!runtimeReady) {
      setError("The local runtime is not ready.");
      return null;
    }
    const commandScope = securityScopeRef.current;
    const commandGeneration = securityGenerationRef.current;
    if (action === "disable") clearRecoverySecrets();
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
      setPending(null);
    }
  }, [clearRecoverySecrets, pending, runtimeReady, shell]);

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
              isDisabled={!runtimeReady || pending !== null}
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
              || pending !== null
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
                isDisabled={!runtimeReady || pending !== null}
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
              isDisabled={!runtimeReady || pending !== null}
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
                isDisabled={!runtimeReady || pending !== null}
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
                    isDisabled={!runtimeReady || pending !== null}
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
                isDisabled={!runtimeReady || pending !== null}
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
              isDisabled={!runtimeReady || pending !== null}
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
