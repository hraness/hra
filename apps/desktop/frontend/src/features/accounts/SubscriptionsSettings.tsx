import { useCallback, useRef, useState } from "react";

import { Button, IconButton } from "@hraness/ui";

import type {
  AccountSummary,
  HumanAccountSnapshot,
  RuntimeDomainCommand,
} from "../../../../contracts/runtime";
import { runtimeHumanCredentialReconnectConfirmation } from "../../../../contracts/runtime";
import {
  type RuntimeShell,
  useRuntimeShellSelector,
} from "../../runtime";
import { RuntimeRetryButton } from "../RuntimeRetryButton";
import {
  accountsEqual,
  runtimeAvailabilityEqual,
  selectAccountCreationAvailable,
  selectAllAccounts,
  selectHumanAccount,
  selectRuntimeAvailability,
} from "../chat/model";
import { HarnessSettings } from "../harness/HarnessSettings";
import { HRAIcon } from "../chat/Icon";
import { SessionSyncSettings } from "./SessionSyncSettings";

type AccountAction = "cancel" | "connect" | "create" | "logout" | "open" | "recover" | "reinspect" | "restart";

type AccountStatusInput = Readonly<
  Pick<AccountSummary, "authState" | "identityLabel"> & {
    usageRemainingPercent?: number | null | undefined;
  }
>;

export function accountStatus(account: AccountStatusInput): string | null {
  switch (account.authState) {
    case "signedIn": {
      const remaining = typeof account.usageRemainingPercent === "number"
        ? `${String(Math.round(account.usageRemainingPercent))}% remaining`
        : null;
      if (account.identityLabel === null) return remaining;
      return remaining === null
        ? account.identityLabel
        : `${account.identityLabel} · ${remaining}`;
    }
    case "signingIn":
      return "Signing in";
    case "signingOut":
      return "Signing out";
    case "expired":
      return "Sign-in expired";
    case "signedOut":
      return "Not connected";
    case "unknown":
      return "Connection unknown";
  }
}

export function humanAccountStatus(account: HumanAccountSnapshot): string | null {
  switch (account.state) {
    case "unavailable":
      return account.reason === "initializing"
        ? "Checking availability"
        : "Unavailable in this build";
    case "signedOut":
      return "Not connected";
    case "signingIn":
      return "Signing in";
    case "signedIn":
      return account.profile.user.email;
    case "recoveryRequired":
      return "Reconnect after update";
    case "error":
      return account.message;
  }
}

export function humanAccountDescription(account: HumanAccountSnapshot): string {
  switch (account.state) {
    case "unavailable": {
      if (account.reason === "configuration_missing") {
        return "This build does not have an HRA Cloud endpoint configured.";
      }
      if (account.reason === "configuration_invalid") {
        return "This build cannot use its configured HRA Cloud endpoint.";
      }
      return "Checking this build's HRA Cloud connection.";
    }
    case "signedIn":
      return "This Mac is connected to HRA Cloud. Session sync remains off until you enable it below.";
    case "signingIn":
      return "Complete sign-in in your browser to connect this Mac to HRA Cloud.";
    case "recoveryRequired":
      return "Reconnect the protected credential before signing in to HRA Cloud.";
    case "error":
    case "signedOut":
      return "Sign in to connect this Mac to HRA Cloud. Session sync remains off until you enable it below.";
  }
}

function canStartHumanSignIn(account: HumanAccountSnapshot): boolean {
  return account.state === "signedOut" || (
    account.state === "error" && (
      account.code === "AUTHENTICATION_FAILED" ||
      account.code === "AUTH_REFRESH_INDETERMINATE" ||
      account.code === "SIGNED_OUT"
    )
  );
}

function withoutKey<Value>(values: ReadonlyMap<string, Value>, key: string): ReadonlyMap<string, Value> {
  const next = new Map(values);
  next.delete(key);
  return next;
}

export function SubscriptionsSettings({
  shell,
}: {
  readonly shell: RuntimeShell;
}) {
  const accounts = useRuntimeShellSelector(shell, selectAllAccounts, accountsEqual);
  const accountCreationAvailable = useRuntimeShellSelector(
    shell,
    selectAccountCreationAvailable,
  );
  const humanAccount = useRuntimeShellSelector(
    shell,
    selectHumanAccount,
    Object.is,
  );
  const availability = useRuntimeShellSelector(
    shell,
    selectRuntimeAvailability,
    runtimeAvailabilityEqual,
  );
  const [pending, setPending] = useState<ReadonlyMap<string, AccountAction>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [reconnectConsentRevision, setReconnectConsentRevision] =
    useState<number | null>(null);
  const activeScopes = useRef(new Set<string>());
  const runtimeReady = availability.kind === "ready";

  const run = useCallback(async (
    scope: string,
    action: AccountAction,
    command: RuntimeDomainCommand,
  ) => {
    if (activeScopes.current.has(scope)) return null;
    if (!runtimeReady) {
      const message = availability.kind === "unavailable"
        ? availability.message
        : "The local runtime is still connecting.";
      setErrors((current) => new Map(current).set(scope, message));
      return null;
    }
    activeScopes.current.add(scope);
    setPending((current) => new Map(current).set(scope, action));
    setErrors((current) => withoutKey(current, scope));
    try {
      const response = await shell.dispatch(command);
      if (!response.ok) {
        setErrors((current) => new Map(current).set(scope, response.error.message));
        return null;
      }
      return response.result;
    } catch (reason: unknown) {
      setErrors((current) => new Map(current).set(
        scope,
        reason instanceof Error ? reason.message : "The local runtime did not complete the request.",
      ));
      return null;
    } finally {
      activeScopes.current.delete(scope);
      setPending((current) => current.get(scope) === action
        ? withoutKey(current, scope)
        : current);
    }
  }, [availability, runtimeReady, shell]);

  const addSubscription = useCallback(async () => {
    const result = await run("new", "create", {
      type: "account.create",
      label: `Codex ${accounts.length + 1}`,
    });
    if (result?.type !== "account") return;
    await run(result.account.id, "connect", {
      type: "account.login.start",
      accountProfileId: result.account.id,
      mode: "browser",
    });
  }, [accounts.length, run]);

  const reconnectHumanAccount = useCallback(async () => {
    if (humanAccount.state !== "recoveryRequired") return;
    const recovered = await run("human", "recover", {
      type: "human.credentials.reconnect",
      expectedRevision: humanAccount.revision,
      confirmation: runtimeHumanCredentialReconnectConfirmation,
    });
    if (recovered?.type !== "accepted") return;
    setReconnectConsentRevision(null);
  }, [humanAccount, run]);

  const reconnectConsentActive = humanAccount.state === "recoveryRequired" &&
    reconnectConsentRevision === humanAccount.revision;

  const accountCommand = useCallback((
    account: AccountSummary,
    action: AccountAction,
    command: RuntimeDomainCommand,
  ) => {
    void run(account.id, action, command);
  }, [run]);

  return (
    <div className="settings-page">
      <section aria-labelledby="subscriptions-title" className="settings-section">
        <div className="settings-section__heading">
          <div>
            <h2 id="subscriptions-title">Codex subscriptions</h2>
          </div>
          <IconButton
            aria-label="Add subscription"
            controlClassName="settings-add"
            isDisabled={!runtimeReady || !accountCreationAvailable || pending.has("new")}
            isPending={pending.get("new") === "create"}
            onPress={() => void addSubscription()}
            size="compact"
            tooltip={accountCreationAvailable
              ? "Add subscription"
              : "Delete retained subscription data to add another"}
            type="button"
            variant="quiet"
          >
            <HRAIcon name="plus" />
          </IconButton>
        </div>

        {errors.get("new") === undefined ? null : (
          <p className="settings-error" role="alert">{errors.get("new")}</p>
        )}
        {availability.kind === "connecting" ? (
          <p className="settings-note" role="status">Connecting to the local runtime…</p>
        ) : availability.kind === "unavailable" ? (
          <div className="settings-note" role="status">
            <span>{availability.message}</span>
            {availability.reconnectable ? (
              <RuntimeRetryButton shell={shell} />
            ) : null}
          </div>
        ) : null}

        {accounts.length === 0 ? (
          <p className="settings-empty">No subscriptions connected.</p>
        ) : (
          <ul className="subscription-list">
            {accounts.map((account) => {
              const operation = pending.get(account.id) ?? null;
              const login = account.login;
              const waitingForBrowser = login.state === "waitingForBrowser";
              const signingIn = account.authState === "signingIn";
              const signingOut = account.authState === "signingOut";
              const signedIn = account.authState === "signedIn";
              const restartable = account.runtime.state === "failed" &&
                account.runtime.canRestart;
              const status = accountStatus(account);
              return (
                <li key={account.id}>
                  <div className="subscription-identity">
                    <strong>{account.label}</strong>
                    {status === null ? null : <span>{status}</span>}
                  </div>
                  <div aria-label={`${account.label} actions`} className="subscription-actions" role="group">
                    {restartable ? (
                      <IconButton
                        aria-label={`Restart ${account.label}`}
                        isDisabled={!runtimeReady || operation !== null}
                        isPending={operation === "restart"}
                        onPress={() => accountCommand(account, "restart", {
                          type: "runtime.restartAccount",
                          accountProfileId: account.id,
                        })}
                        size="compact"
                        tooltip={`Restart ${account.label}`}
                        type="button"
                        variant="quiet"
                      >
                        <HRAIcon name="refresh" />
                      </IconButton>
                    ) : null}
                    {signedIn || signingOut ? (
                      <IconButton
                        aria-label={`${signingOut ? "Retry logout for" : "Log out"} ${account.label}`}
                        isDisabled={!runtimeReady || operation !== null}
                        isPending={operation === "logout"}
                        onPress={() => accountCommand(account, "logout", {
                          type: "account.logout",
                          accountProfileId: account.id,
                        })}
                        size="compact"
                        tooltip={`${signingOut ? "Retry logout for" : "Log out"} ${account.label}`}
                        type="button"
                        variant="quiet"
                      >
                        <HRAIcon name="power" />
                      </IconButton>
                    ) : waitingForBrowser ? (
                      <IconButton
                        aria-label={`Open sign-in for ${account.label}`}
                        isDisabled={!runtimeReady || operation !== null}
                        isPending={operation === "open"}
                        onPress={() => accountCommand(account, "open", {
                          type: "account.login.open",
                          accountProfileId: account.id,
                        })}
                        size="compact"
                        tooltip={`Open sign-in for ${account.label}`}
                        type="button"
                        variant="quiet"
                      >
                        <HRAIcon name="open" />
                      </IconButton>
                    ) : !signingIn && !signingOut ? (
                      <IconButton
                        aria-label={`Connect ${account.label}`}
                        isDisabled={!runtimeReady || operation !== null}
                        isPending={operation === "connect"}
                        onPress={() => accountCommand(account, "connect", {
                          type: "account.login.start",
                          accountProfileId: account.id,
                          mode: "browser",
                        })}
                        size="compact"
                        tooltip={`Connect ${account.label}`}
                        type="button"
                        variant="quiet"
                      >
                        <HRAIcon name="open" />
                      </IconButton>
                    ) : null}
                    {signingIn ? (
                      <IconButton
                        aria-label={`Cancel sign-in for ${account.label}`}
                        isDisabled={!runtimeReady || operation !== null}
                        isPending={operation === "cancel"}
                        onPress={() => accountCommand(account, "cancel", {
                          type: "account.login.cancel",
                          accountProfileId: account.id,
                        })}
                        size="compact"
                        tooltip={`Cancel sign-in for ${account.label}`}
                        type="button"
                        variant="quiet"
                      >
                        <HRAIcon name="close" />
                      </IconButton>
                    ) : null}
                  </div>
                  {errors.get(account.id) === undefined ? null : (
                    <p className="settings-error" role="alert">{errors.get(account.id)}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="cloud-account-title" className="settings-section">
          <div className="settings-section__heading">
            <div className="subscription-identity">
              <h2 id="cloud-account-title">HRA Cloud</h2>
              <span>{humanAccountStatus(humanAccount)}</span>
            </div>
            <div aria-label="HRA Cloud actions" className="subscription-actions" role="group">
              {humanAccount.state === "signedIn" ? (
                <IconButton
                  aria-label="Log out HRA Cloud"
                  isDisabled={!runtimeReady || pending.has("human")}
                  isPending={pending.get("human") === "logout"}
                  onPress={() => void run("human", "logout", { type: "human.signOut" })}
                  size="compact"
                  tooltip="Log out HRA Cloud"
                  type="button"
                  variant="quiet"
                >
                  <HRAIcon name="power" />
                </IconButton>
              ) : humanAccount.state === "signingIn" ? (
                <IconButton
                  aria-label="Cancel HRA Cloud sign-in"
                  isDisabled={!runtimeReady || pending.has("human")}
                  isPending={pending.get("human") === "cancel"}
                  onPress={() => void run("human", "cancel", { type: "human.signIn.cancel" })}
                  size="compact"
                  tooltip="Cancel HRA Cloud sign-in"
                  type="button"
                  variant="quiet"
                >
                  <HRAIcon name="close" />
                </IconButton>
              ) : humanAccount.state === "recoveryRequired" ? (
                <IconButton
                  aria-label="Review HRA Cloud reconnect"
                  isDisabled={!runtimeReady || pending.has("human")}
                  isPending={pending.get("human") === "recover"}
                  onPress={() => setReconnectConsentRevision(humanAccount.revision)}
                  size="compact"
                  tooltip="Review preserved credential recovery"
                  type="button"
                  variant="quiet"
                >
                  <HRAIcon name="refresh" />
                </IconButton>
              ) : humanAccount.state === "error" &&
                  !canStartHumanSignIn(humanAccount) &&
                  (
                    humanAccount.code === "CREDENTIAL_RECOVERY_REQUIRED" ||
                    humanAccount.retryable
                  ) ? (
                <IconButton
                  aria-label="Retry HRA Cloud credential check"
                  isDisabled={!runtimeReady || pending.has("human")}
                  isPending={pending.get("human") === "reinspect"}
                  onPress={() => void run("human", "reinspect", {
                    type: "human.credentials.retry",
                    expectedRevision: humanAccount.revision,
                  })}
                  size="compact"
                  tooltip="Retry the non-destructive credential check"
                  type="button"
                  variant="quiet"
                >
                  <HRAIcon name="refresh" />
                </IconButton>
              ) : humanAccount.state === "unavailable" || canStartHumanSignIn(humanAccount) ? (
                <Button
                  aria-label="Sign in to HRA Cloud"
                  isDisabled={
                    humanAccount.state === "unavailable" ||
                    !runtimeReady ||
                    pending.has("human")
                  }
                  isPending={
                    humanAccount.state !== "unavailable" &&
                    pending.get("human") === "connect"
                  }
                  leading={<HRAIcon name="network" />}
                  onPress={() => void run("human", "connect", { type: "human.signIn.start" })}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  {humanAccount.state !== "unavailable" && pending.get("human") === "connect"
                    ? "Signing in…"
                    : "Sign in to HRA Cloud"}
                </Button>
              ) : null}
            </div>
          </div>
          <p className="settings-empty">{humanAccountDescription(humanAccount)}</p>
          {errors.get("human") === undefined ? null : (
            <p className="settings-error" role="alert">{errors.get("human")}</p>
          )}
          {reconnectConsentActive ? (
            <div
              aria-label="Confirm HRA Cloud reconnect"
              className="settings-inline-confirmation"
              role="group"
            >
              <p>
                The previous credential stays protected in Keychain. Continue
                to reconnect this installation. If this account was retired,
                Connect will start a fresh browser sign-in.
              </p>
              <div className="subscription-actions">
                <IconButton
                  aria-label="Confirm HRA Cloud reconnect"
                  autoFocus
                  isDisabled={!runtimeReady || pending.has("human")}
                  isPending={pending.get("human") === "recover"}
                  onPress={() => void reconnectHumanAccount()}
                  size="compact"
                  tooltip="Preserve the previous credential and reconnect"
                  type="button"
                  variant="quiet"
                >
                  <HRAIcon name="check" />
                </IconButton>
                <IconButton
                  aria-label="Cancel HRA Cloud reconnect"
                  isDisabled={pending.has("human")}
                  onPress={() => setReconnectConsentRevision(null)}
                  size="compact"
                  tooltip="Cancel reconnect"
                  type="button"
                  variant="quiet"
                >
                  <HRAIcon name="close" />
                </IconButton>
              </div>
            </div>
          ) : null}
        </section>
      <SessionSyncSettings shell={shell} />
      <HarnessSettings shell={shell} />
    </div>
  );
}
