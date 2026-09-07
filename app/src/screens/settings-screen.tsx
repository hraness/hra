import { useAuthActions } from "@convex-dev/auth/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { AccountLoginRelay } from "../components/account-login-relay";
import {
  BackIcon,
  ChoiceGroup,
  CommandHint,
  EmptyRow,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "../components/settings-list";
import { useCustody } from "../custody/custody-context";
import { useArchivedSessions } from "../data/archived-sessions";
import { useCommandState, useSubmitCommand } from "../data/commands";
import {
  deviceCommandCommittedRowUnavailableMessage,
  DeviceCommandConsumedResultUnreadableError,
  DeviceCommandConsumePrecommitError,
  DeviceCommandResponseInvalidError,
  useConsumeDeviceCommandResult,
  useDeviceCommandTracker,
  useReadDeviceCommandResult,
  useSubmitDeviceCommand,
} from "../data/device-commands";
import { useDevices, useServerClock, type DeviceView } from "../data/devices";
import { useDeviceRegistries } from "../data/registry";
import { useSessionHeads } from "../data/session-heads";
import { pageSize } from "../env";
import {
  type CommandState,
  type DeviceCommandResultPayload,
  type RemoteCommandPayload,
  type SupportedPreset,
} from "../hra/cloud";
import { formatRelativeTime, formatUtcDay } from "../model/relative-time";
import {
  accountLoginStartCommand,
  accountLoginStatusCommand,
  admitHostedLoginHandoff,
  beginAccountLoginAction,
  completeAccountLoginSubmission,
  deviceCommandNotice,
  finishAccountLoginHandoff,
  initialAccountLoginActionState,
  type AccountLoginActionState,
  notificationHoursCommand,
  parseNotificationClockMinute,
} from "../model/device-commands";
import {
  approvalModeCommand,
  approvalModeLabels,
  approvalModes,
  defaultPresetCommand,
  gatewayKeyCommand,
  gatewayKeyShapeMessage,
  isGatewayKeyShape,
  presetChoices,
  presetLabels,
  settingsCommandLabel,
  showThinkingCommand,
  unarchiveSessionCommand,
  type ApprovalMode,
} from "../model/settings-commands";
import {
  accountBrowserLoginAllowed,
  accountRows,
  accountStatusLabels,
  allScheduledTasks,
  attentionEmailPresentation,
  commandTargetForMachine,
  machineLabelsByDevice,
  personalSessionAdoptionCommand,
  shortSessionId,
  type AccountRowView,
  type ArchivedSessionView,
  type CommandTarget,
  type MachineView,
} from "../model/settings-view";

/*
 * Settings.
 *
 * Read side: one encrypted registry per machine (`devices:listRegistries`), the
 * device list, and the session heads the reader has already paged in. Write
 * side: one durable command per control, through the same encrypted, custodian
 * bound path every other command uses. Nothing on this screen mutates hosted
 * state directly, and nothing here can administer the account: a browser device
 * is refused `devices:revoke` by the server, so revocation is an instruction to
 * run on a machine rather than a button.
 */

const terminalCommandStates = new Set<CommandState>([
  "ambiguous",
  "applied",
  "cancelled",
  "expired",
  "failed",
]);

/** Where a settings command goes. Its progress notice is named by its kind. */
type SettingsCommandInput = Readonly<{
  payload: RemoteCommandPayload;
  target: CommandTarget;
}>;

type AccountLoginRelayResult = Extract<
  DeviceCommandResultPayload,
  { handoffVersion: 2; kind: "account_login_start" }
>;

type SettingsCommandRunner = Readonly<{
  busy: boolean;
  notice: string | null;
  run: (input: SettingsCommandInput) => void;
}>;

/**
 * One in-flight settings command with its state.
 *
 * A command is durable and asynchronous: the browser learns it was applied only
 * when the daemon settles it, so each control reports the command's own state
 * until it reaches a terminal one instead of optimistically moving the control.
 * One command at a time per card keeps the hook count fixed and stops a reader
 * from queueing two contradictory defaults on one machine.
 */
function useSettingsCommand(): SettingsCommandRunner {
  const submit = useSubmitCommand();
  const [pending, setPending] = useState<Readonly<{ label: string; publicId: string }> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const record = useCommandState(pending?.publicId ?? null);

  useEffect(() => {
    if (pending === null || record === null || !terminalCommandStates.has(record.state)) return;
    const detail = record.resultCode === null ? "" : ` (${record.resultCode})`;
    setNotice(record.state === "applied"
      ? `${pending.label} applied.`
      : `${pending.label} ${record.state}${detail}.`);
    setPending(null);
  }, [pending, record]);

  const run = useCallback((input: SettingsCommandInput) => {
    const label = settingsCommandLabel(input.payload.kind);
    setNotice(`${label} submitted.`);
    void submit({
      executionDevicePublicId: input.target.executionDevicePublicId,
      payload: input.payload,
      sessionPublicId: input.target.sessionPublicId,
    })
      .then((publicId) => { setPending({ label, publicId }); })
      .catch((failure: unknown) => {
        setNotice(failure instanceof Error ? failure.message : "The command was not accepted.");
      });
  }, [submit]);

  const progress = pending === null
    ? notice
    : `${pending.label}: ${record === null ? "pending" : record.state}.`;

  return { busy: pending !== null, notice: progress, run };
}

function Notice({ children }: Readonly<{ children: string | null }>) {
  if (children === null) return null;
  return <p className="text-xs text-ink-muted" role="status">{children}</p>;
}

function openSession(sessionPublicId: string): void {
  location.hash = `#/session/${sessionPublicId}`;
}

const personalSessionProviders = Object.freeze([
  { label: "Codex", provider: "codex" },
  { label: "Claude Code", provider: "claude" },
] as const);

/**
 * The gateway key entry.
 *
 * The value is held in one controlled input, cleared the moment it is handed to
 * the command builder, and never written to a notice, a log, or storage. The
 * shape check mirrors the daemon's so a mistyped key is refused here rather
 * than travelling encrypted to a machine that will reject it.
 */
function GatewayKeyForm({
  disabled,
  onSubmit,
}: Readonly<{ disabled: boolean; onSubmit: (payload: RemoteCommandPayload) => void }>) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!isGatewayKeyShape(value)) {
      setError(gatewayKeyShapeMessage);
      return;
    }
    const payload = gatewayKeyCommand(value);
    setValue("");
    setError(null);
    onSubmit(payload);
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label className="text-xs text-ink-muted" htmlFor={inputId}>
        Set the AI Gateway key for prose autorespond
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoComplete="off"
          className="flex-1"
          disabled={disabled}
          id={inputId}
          onChange={(event) => { setValue(event.target.value); }}
          placeholder="Gateway key"
          spellCheck={false}
          type="password"
          value={value}
        />
        <Button disabled={disabled || value.length === 0} type="submit" variant="secondary">
          Set key
        </Button>
      </div>
      {error === null ? null : <p className="text-xs text-danger" role="alert">{error}</p>}
    </form>
  );
}

function formatClockMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Separate from session settings: this is a machine-addressed, local CAS command. */
export function NotificationHoursForm({ machine }: Readonly<{ machine: MachineView }>) {
  const submit = useSubmitDeviceCommand();
  const notificationHours = machine.notificationHours;
  const projectedStart = notificationHours === null
    ? ""
    : formatClockMinute(notificationHours.startMinute);
  const projectedEnd = notificationHours === null
    ? ""
    : formatClockMinute(notificationHours.endMinute);
  const projectedTimeZone = notificationHours?.timeZone ?? "";
  const projectedRevision = notificationHours?.revision ?? null;
  const [submittedRevision, setSubmittedRevision] = useState<number | null>(null);
  const [enqueuePending, setEnqueuePending] = useState(false);
  const enqueueStarted = useRef(false);
  const [start, setStart] = useState(projectedStart);
  const [end, setEnd] = useState(projectedEnd);
  const [timeZone, setTimeZone] = useState(projectedTimeZone);
  const [error, setError] = useState<string | null>(null);
  const handleUnavailable = useCallback(() => {
    setSubmittedRevision(null);
    setError(deviceCommandCommittedRowUnavailableMessage);
  }, []);
  const { observation, setHandle: setCommandHandle } = useDeviceCommandTracker(
    handleUnavailable,
  );
  const command = observation.record;
  const enabled = notificationHours !== null
    && machine.deviceCommandsAllowed
    && machine.deviceStatus === "active";
  const awaitingProjection = command?.state === "applied"
    && submittedRevision !== null
    && projectedRevision === submittedRevision;
  const commandBusy = enqueuePending
    || awaitingProjection
    || (observation.status !== "idle"
      && (command === null || !terminalCommandStates.has(command.state)));
  const notice = awaitingProjection
    ? { text: "Saved. Waiting for the machine view to refresh…", tone: "pending" as const }
    : deviceCommandNotice(command);

  useEffect(() => {
    if (projectedRevision === null) return;
    setStart(projectedStart);
    setEnd(projectedEnd);
    setTimeZone(projectedTimeZone);
  }, [projectedEnd, projectedRevision, projectedStart, projectedTimeZone]);

  const submitHours = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (notificationHours === null || !enabled || commandBusy || enqueueStarted.current) return;
    const startMinute = parseNotificationClockMinute(start);
    const endMinute = parseNotificationClockMinute(end);
    if (startMinute === null || endMinute === null) {
      setError("Enter both times as valid local times.");
      return;
    }
    let payload;
    try {
      payload = notificationHoursCommand({
        endMinute,
        expectedRevision: notificationHours.revision,
        startMinute,
        timeZone,
        version: 1,
      });
    } catch {
      setError("Choose a nonempty time range and a valid IANA time zone.");
      return;
    }
    setError(null);
    setCommandHandle(null);
    setSubmittedRevision(notificationHours.revision);
    enqueueStarted.current = true;
    setEnqueuePending(true);
    void submit({ payload, targetDevicePublicId: machine.devicePublicId })
      .then((publicId) => {
        setCommandHandle({ publicId, responseValidated: true });
      })
      .catch((failure: unknown) => {
        if (failure instanceof DeviceCommandResponseInvalidError) {
          setCommandHandle({
            publicId: failure.commandPublicId,
            responseValidated: false,
          });
          return;
        }
        setSubmittedRevision(null);
        setError(failure instanceof Error ? failure.message : "The machine did not accept the request.");
      })
      .finally(() => {
        enqueueStarted.current = false;
        setEnqueuePending(false);
      });
  };

  if (machine.notificationHours === null) {
    return machine.notificationHoursStatus === "unreadable"
      ? <p className="text-xs text-danger">This machine’s notification hours could not be read.</p>
      : <p className="text-xs text-ink-muted">Unavailable on this machine’s current daemon.</p>;
  }
  const edit = (setter: (value: string) => void, value: string) => {
    setCommandHandle(null);
    setSubmittedRevision(null);
    setError(null);
    setter(value);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submitHours}>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Notification hours start" disabled={!enabled || commandBusy} onChange={(event) => edit(setStart, event.target.value)} type="time" value={start} />
        <span className="text-xs text-ink-muted">to</span>
        <Input aria-label="Notification hours end" disabled={!enabled || commandBusy} onChange={(event) => edit(setEnd, event.target.value)} type="time" value={end} />
        <Input aria-label="Notification hours time zone" className="min-w-40 flex-1" disabled={!enabled || commandBusy} onChange={(event) => edit(setTimeZone, event.target.value)} value={timeZone} />
        <Button disabled={!enabled || commandBusy} size="small" type="submit" variant="secondary">Save</Button>
      </div>
      <p className="text-xs text-ink-muted">Stored for future notification timing only. Notification delivery is not active, and approvals and autonomy do not read this schedule.</p>
      {machine.deviceStatus === "active"
        ? null
        : <p className="text-xs text-attention">This device is not active, so its schedule is read-only.</p>}
      {error === null ? null : <p className="text-xs text-danger" role="alert">{error}</p>}
      {observation.protocolWarning === null ? null : (
        <p className="text-xs text-danger" role="status">
          {observation.protocolWarning}
        </p>
      )}
      {notice === null ? null : <p className={notice.tone === "error" ? "text-xs text-danger" : "text-xs text-ink-muted"} role="status">{notice.text}</p>}
    </form>
  );
}

function MachineCard({
  machine,
  now,
  target,
}: Readonly<{ machine: MachineView; now: number; target: CommandTarget | null }>) {
  const command = useSettingsCommand();
  const disabled = target === null || command.busy;
  const attentionEmail = attentionEmailPresentation(machine);

  const send = (payload: RemoteCommandPayload) => {
    if (target === null) return;
    command.run({ payload, target });
  };

  return (
    <SettingsCard>
      <SettingsRow
        control={(
          <Badge tone={machine.online ? "accent" : "neutral"}>
            {machine.online ? "online" : "offline"}
          </Badge>
        )}
        description={`hra ${machine.daemonVersion}, heartbeat ${formatRelativeTime(machine.heartbeatAt, now)}`}
        title={machine.label}
      >
        {target === null ? (
          <p className="text-xs text-attention">
            This machine has no live session, so session-routed settings cannot be sent from the browser.
            Notification hours use a machine-addressed command and do not need a live session; change other settings on the machine or start a session first.
          </p>
        ) : null}
        <Notice>{command.notice}</Notice>
      </SettingsRow>

      <SettingsRow
        control={(
          <ChoiceGroup<ApprovalMode>
            disabled={disabled}
            label={`Approval mode on ${machine.label}`}
            onSelect={(mode) => { send(approvalModeCommand(mode)); }}
            options={approvalModes.map((mode) => ({ label: approvalModeLabels[mode], value: mode }))}
            value={machine.defaultApprovalMode}
          />
        )}
        description="The default for new sessions on this machine."
        title="Approval mode"
      />

      <SettingsRow
        description="The local time window for notifications on this machine."
        title="Notification hours"
      >
        <NotificationHoursForm machine={machine} />
      </SettingsRow>

      <SettingsRow
        control={<Badge tone={attentionEmail.tone}>{attentionEmail.label}</Badge>}
        description={attentionEmail.description}
        title="Attention email"
      >
        <p className="text-xs text-ink-muted">
          Read-only here. This local opt-in does not by itself activate hosted delivery.
        </p>
        <CommandHint>hra notification-email status</CommandHint>
      </SettingsRow>

      <SettingsRow
        control={(
          <Switch
            checked={machine.showThinkingDefault}
            disabled={disabled}
            label={`Show thinking on ${machine.label}`}
            onCheckedChange={(enabled) => { send(showThinkingCommand(enabled)); }}
          />
        )}
        description="Upload reasoning summaries so they can be read here."
        title="Show thinking"
      />

      <SettingsRow
        control={(
          <ChoiceGroup<SupportedPreset>
            disabled={disabled}
            label={`Default preset on ${machine.label}`}
            onSelect={(preset) => { send(defaultPresetCommand(preset)); }}
            options={presetChoices.map((preset) => ({
              label: presetLabels[preset],
              value: preset,
            }))}
            value={machine.defaultPreset === "astra" ? null : machine.defaultPreset}
          />
        )}
        description="The model preset new sessions start with."
        title="Default preset"
      />

      {machine.projects.length === 0 ? null : (
        <SettingsRow
          description={machine.projects.map((project) => project.label).join(", ")}
          title={`Projects (${machine.projects.length})`}
        />
      )}

      {machine.sessionAdoption === null ? (
        <SettingsRow
          control={<Badge tone="neutral">unavailable</Badge>}
          description="Update HRA on this machine to publish its local adoption status."
          title="Personal sessions"
        />
      ) : personalSessionProviders.map(({ label, provider }) => {
        const adoption = machine.sessionAdoption?.[provider];
        if (adoption === undefined) return null;
        const command = personalSessionAdoptionCommand(provider, adoption.enabled);
        return (
          <SettingsRow
            control={(
              <Badge tone={adoption.enabled ? "accent" : "neutral"}>
                {adoption.enabled ? "enabled" : "off"}
              </Badge>
            )}
            description={`${adoption.pending} pending, ${adoption.adopted} adopted, and ${adoption.fenced} fenced. ${adoption.enabled ? "New discovery is enabled." : "Disabling discovery does not change sessions already under HRA control."}`}
            key={provider}
            title={`${label} personal sessions`}
          >
            <p className="text-xs text-ink-muted">
              Personal-home access can be changed only from this machine.
            </p>
            <CommandHint>{command}</CommandHint>
          </SettingsRow>
        );
      })}

      <SettingsRow
        control={(
          <Badge tone={machine.proseAutorespondConfigured ? "accent" : "neutral"}>
            {machine.proseAutorespondConfigured ? "configured" : "not configured"}
          </Badge>
        )}
        description="Prose autorespond runs only once a gateway key is in this machine's secret custody."
        title="Prose autorespond"
      >
        <GatewayKeyForm
          disabled={disabled}
          onSubmit={(payload) => { send(payload); }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

function ArchivedSessionRow({
  now,
  session,
}: Readonly<{ now: number; session: ArchivedSessionView }>) {
  const command = useSettingsCommand();
  const retired = session.retiredProvider === "devin";
  const day = formatUtcDay(session.updatedAt);
  const machine = session.machineLabel ?? shortSessionId(session.executionDevicePublicId);

  return (
    <SettingsRow
      control={(
        <Button
          disabled={command.busy || retired}
          onClick={() => {
            if (retired) return;
            command.run({
              payload: unarchiveSessionCommand(),
              target: {
                executionDevicePublicId: session.executionDevicePublicId,
                sessionPublicId: session.publicId,
              },
            });
          }}
          size="small"
          variant="secondary"
        >
          Unarchive
        </Button>
      )}
      description={`${machine}, last updated ${formatRelativeTime(session.updatedAt, now)}${day === null ? "" : ` on ${day}`}`}
      title={session.title}
    >
      {retired ? <p className="text-xs text-ink-muted">Devin retired · read-only</p> : null}
      <Notice>{command.notice}</Notice>
    </SettingsRow>
  );
}

/** Browser login actions, admitted only by both machine-side switches. */
export function AccountBrowserLoginControls({
  account,
  busy,
  handoffAvailable = false,
  onStart,
  onStatus,
}: Readonly<{
  account: AccountRowView;
  busy: boolean;
  handoffAvailable?: boolean;
  onStart: () => void;
  onStatus: () => void;
}>) {
  if (!accountBrowserLoginAllowed(account)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {account.status === "signed_out" && !handoffAvailable ? (
        <Button
          disabled={busy}
          onClick={onStart}
          size="small"
          variant="secondary"
        >
          Link here
        </Button>
      ) : null}
      <Button
        disabled={busy}
        onClick={onStatus}
        size="small"
        variant="ghost"
      >
        Check status
      </Button>
    </div>
  );
}

/**
 * One account, with the browser linking flow behind the machine's local opt-in.
 *
 * With either device commands or account linking off, the row shows the CLI
 * instruction and no browser action. With both on, "Link here" relays the
 * complete provider device-code handoff. The URL and one-time code are
 * account-key encrypted, single use, and short lived; the hosted row erases
 * their shared ciphertext on the first read. Poll names this row's account and
 * returns only its status and a bounded local instruction.
 */
export function AccountRow({
  account,
  now,
  serverClockReady,
}: Readonly<{ account: AccountRowView; now: number; serverClockReady: boolean }>) {
  const submitDeviceCommand = useSubmitDeviceCommand();
  const consumeResult = useConsumeDeviceCommandResult();
  const readResult = useReadDeviceCommandResult();
  const [relay, setRelay] = useState<AccountLoginRelayResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [consumeRetry, setConsumeRetry] = useState<Readonly<{
    commandPublicId: string;
    expiresAt: number;
  }> | null>(null);
  const [consumeAttempt, setConsumeAttempt] = useState(0);
  const [loginAction, setLoginAction] = useState<AccountLoginActionState>(
    initialAccountLoginActionState,
  );
  const loginActionRef = useRef<AccountLoginActionState>(initialAccountLoginActionState);
  const consumedCommand = useRef<string | null>(null);
  const readStatusCommand = useRef<string | null>(null);
  const activeCommand = useRef<string | null>(null);
  const mounted = useRef(true);
  const localLoginCommand = account.provider === "codex"
    ? `hra account login ${account.publicId}`
    : `hra account login ${account.publicId} --provider ${account.provider}`;
  const lostHandoffInstruction = `Check status first. If a login is still pending and you cannot finish it, run \`hra account login-cancel ${account.publicId}\` on ${account.machineLabel} before linking again.`;
  const busy = loginAction.phase !== "idle";

  const updateLoginAction = useCallback((next: AccountLoginActionState) => {
    loginActionRef.current = next;
    setLoginAction(next);
  }, []);

  const releaseLoginHandoff = useCallback((publicId: string) => {
    const current = loginActionRef.current;
    const next = finishAccountLoginHandoff(current, publicId);
    if (next !== current) updateLoginAction(next);
  }, [updateLoginAction]);

  const handleUnavailable = useCallback((commandPublicId: string) => {
    activeCommand.current = null;
    setStatus(deviceCommandCommittedRowUnavailableMessage);
    releaseLoginHandoff(commandPublicId);
  }, [releaseLoginHandoff]);
  const { observation, setHandle: setCommandHandle } = useDeviceCommandTracker(
    handleUnavailable,
  );
  const command = observation.record;
  const notice = deviceCommandNotice(command);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The relay is exchanged exactly once, as soon as the command settles. A
  // second tab watching the same command gets nothing, which is the point.
  useEffect(() => {
    if (
      command === null
      || command.state !== "applied"
      || !command.resultSingleUse
      || command.resultConsumed
      || command.kind !== "account_login_start"
      || consumedCommand.current === command.publicId
    ) return;
    const admission = admitHostedLoginHandoff({
      now,
      serverClockReady,
      settledAt: command.updatedAt,
    });
    if (admission.status === "awaiting_server_clock") return;
    // Parsing the reactive command creates a fresh object on every render.
    // Fence by public id only after hosted time is ready, before the mutation,
    // so neither clock skew nor a relay-driven render can lose the one read.
    consumedCommand.current = command.publicId;
    setConsumeRetry(null);
    if (admission.status === "expired_or_invalid") {
      setStatus(`This browser's login handoff expired. ${lostHandoffInstruction}`);
      releaseLoginHandoff(command.publicId);
      return;
    }
    void consumeResult(
      command.publicId,
      admission.expiresAt,
    )
      .then((result) => {
        if (!mounted.current || activeCommand.current !== command.publicId) return;
        if (result === null) {
          setStatus(`No login handoff was available. It expired, was already read, or requires an HRA update on the machine. ${lostHandoffInstruction}`);
          releaseLoginHandoff(command.publicId);
          return;
        }
        if (
          result.kind === "account_login_start"
          && "handoffVersion" in result
        ) {
          setRelay(result);
        } else if (result.kind === "account_login_start") {
          setStatus("The machine returned a legacy login handoff. Update HRA on the machine before trying again.");
        }
        releaseLoginHandoff(command.publicId);
      })
      .catch((failure: unknown) => {
        if (!mounted.current || activeCommand.current !== command.publicId) return;
        if (failure instanceof DeviceCommandConsumePrecommitError) {
          // The hosted transaction definitely aborted, so retain custody of
          // this exact handoff and let the reader explicitly retry it.
          setConsumeRetry({ commandPublicId: command.publicId, expiresAt: admission.expiresAt });
          setStatus(failure.message);
          return;
        }
        if (failure instanceof DeviceCommandConsumedResultUnreadableError) {
          setStatus(
            `The one-time login handoff was consumed but could not be read. Unlock this browser again. ${lostHandoffInstruction}`,
          );
        } else {
          setStatus("The machine returned an incompatible login handoff. Update HRA on the machine before trying again.");
        }
        releaseLoginHandoff(command.publicId);
      });
  }, [command, consumeAttempt, consumeResult, lostHandoffInstruction, now, releaseLoginHandoff, serverClockReady]);

  // Failed, cancelled, ambiguous, and hosted-expired starts have no relay to
  // consume. An applied result consumed by another tab also releases the row,
  // while this tab's own in-progress exchange retains it through decryption.
  useEffect(() => {
    if (
      command === null
      || command.kind !== "account_login_start"
      || !terminalCommandStates.has(command.state)
    ) return;
    if (command.state === "applied") {
      if (command.resultSingleUse && !command.resultConsumed) return;
      if (consumedCommand.current === command.publicId) return;
      setStatus(command.resultSingleUse
        ? `No login handoff was available. It expired or was already read. ${lostHandoffInstruction}`
        : "The machine returned a legacy login handoff. Update HRA on the machine before trying again.");
    }
    releaseLoginHandoff(command.publicId);
  }, [command, lostHandoffInstruction, releaseLoginHandoff]);

  // A registry read may lag the handoff, so signed-out alone cannot erase it.
  // Positive sign-in or recovery evidence does close this browser's handoff.
  useEffect(() => {
    if (account.status === "signed_in" || account.status === "recovery_required") {
      setRelay(null);
    }
  }, [account.status, relay]);

  // Server-corrected `now` handles clock skew. At the deadline, erase a read
  // handoff or release a rejected read without requiring another consumption.
  useEffect(() => {
    const expiresAt = relay?.expiresAt ?? consumeRetry?.expiresAt;
    if (expiresAt === undefined) return;
    const maximumBrowserTimerMs = 2_147_483_647;
    const delay = Math.min(Math.max(0, expiresAt - now), maximumBrowserTimerMs);
    const timer = setTimeout(() => {
      setRelay((current) => current === relay ? null : current);
      if (consumeRetry !== null) {
        setConsumeRetry(null);
        releaseLoginHandoff(consumeRetry.commandPublicId);
      }
      setStatus(`This browser's login handoff expired. ${lostHandoffInstruction}`);
    }, delay);
    return () => { clearTimeout(timer); };
  }, [consumeRetry, lostHandoffInstruction, now, relay, releaseLoginHandoff]);

  useEffect(() => {
    if (
      command === null
      || command.state !== "applied"
      || command.kind !== "account_login_status"
      || command.result === null
      || command.resultSingleUse
      || readStatusCommand.current === command.publicId
    ) return;
    readStatusCommand.current = command.publicId;
    void readResult(command.publicId, command.result)
      .then((result) => {
        if (!mounted.current || activeCommand.current !== command.publicId) return;
        if (result.kind !== "account_login_status") {
          setStatus("The machine returned an incompatible login status. Update HRA on the machine before trying again.");
          return;
        }
        if (result.status !== "pending") setRelay(null);
        setStatus(result.instruction);
      })
      .catch(() => {
        if (mounted.current && activeCommand.current === command.publicId) {
          setStatus("The machine returned an unreadable login status. Unlock this browser again and retry.");
        }
      });
  }, [command, readResult]);

  const run = (payload: Parameters<typeof submitDeviceCommand>[0]["payload"]) => {
    if (payload.kind !== "account_login_start" && payload.kind !== "account_login_status") return;
    const next = beginAccountLoginAction(loginActionRef.current, payload.kind);
    if (next === null) return;
    updateLoginAction(next);
    // A new action may replace a completed result, but never an outstanding
    // one-time handoff: the action gate above holds that command through read.
    activeCommand.current = null;
    setCommandHandle(null);
    setConsumeRetry(null);
    // A status read must preserve the code already consumed by this browser.
    // It cannot be fetched again from the hosted single-use result.
    if (payload.kind === "account_login_start") setRelay(null);
    setStatus(null);
    void submitDeviceCommand({ payload, targetDevicePublicId: account.targetDevicePublicId })
      .then((publicId) => {
        if (!mounted.current) return;
        activeCommand.current = publicId;
        setCommandHandle({ publicId, responseValidated: true });
        updateLoginAction(completeAccountLoginSubmission(loginActionRef.current, publicId));
      })
      .catch((failure: unknown) => {
        if (mounted.current) {
          if (failure instanceof DeviceCommandResponseInvalidError) {
            activeCommand.current = failure.commandPublicId;
            setCommandHandle({
              publicId: failure.commandPublicId,
              responseValidated: false,
            });
            updateLoginAction(completeAccountLoginSubmission(
              loginActionRef.current,
              failure.commandPublicId,
            ));
            return;
          }
          setStatus(failure instanceof Error ? failure.message : "The request was not accepted.");
          updateLoginAction(initialAccountLoginActionState);
        }
      });
  };

  return (
    <SettingsRow
      control={(
        <>
          <Badge tone="neutral">{account.provider}</Badge>
          <Badge tone={account.status === "signed_in" ? "accent" : "attention"}>
            {accountStatusLabels[account.status]}
          </Badge>
        </>
      )}
      description={account.machineLabel}
      title={account.label}
    >
      {account.provider === "devin" ? (
        <p className="text-xs text-ink-muted">Devin support is retired. This historical account is read-only.</p>
      ) : accountBrowserLoginAllowed(account) ? (
        <AccountBrowserLoginControls
          account={account}
          busy={busy}
          handoffAvailable={relay !== null && relay.expiresAt > now}
          onStart={() => { run(accountLoginStartCommand(account.publicId)); }}
          onStatus={() => { run(accountLoginStatusCommand(account.publicId)); }}
        />
      ) : (
        <>
          <CommandHint>{localLoginCommand}</CommandHint>
          {account.provider === "claude" ? (
            <p className="text-xs text-ink-muted">
              Run this on its Linux custodian. Claude linking is not available in the browser,
              and macOS refuses before provider launch.
            </p>
          ) : null}
        </>
      )}
      {relay === null ? null : (
        <AccountLoginRelay
          expiresAt={relay.expiresAt}
          key={relay.userCode}
          loginUrl={relay.loginUrl}
          now={now}
          userCode={relay.userCode}
        />
      )}
      {observation.protocolWarning === null ? null : (
        <p className="text-xs text-danger" role="status">
          {observation.protocolWarning}
        </p>
      )}
      {consumeRetry !== null && consumeRetry.commandPublicId === command?.publicId ? (
        <Button
          onClick={() => {
            consumedCommand.current = null;
            setConsumeRetry(null);
            setStatus(null);
            setConsumeAttempt((attempt) => attempt + 1);
          }}
          size="small"
          variant="secondary"
        >
          Try reading again
        </Button>
      ) : null}
      {notice === null ? null : (
        <p
          className={notice.tone === "error" ? "text-xs text-danger" : "text-xs text-ink-muted"}
          role="status"
        >
          {notice.text}
        </p>
      )}
      {status === null ? null : <p className="text-xs text-ink-muted">{status}</p>}
    </SettingsRow>
  );
}

function DeviceRow({ device, now }: Readonly<{ device: DeviceView; now: number }>) {
  const seen = device.lastSeenAt === null
    ? "never seen"
    : `last seen ${formatRelativeTime(device.lastSeenAt, now)}`;

  return (
    <SettingsRow
      control={(
        <>
          <Badge tone="neutral">{device.deviceClass}</Badge>
          <Badge tone={device.status === "active" ? "accent" : "neutral"}>{device.status}</Badge>
          {device.online ? <Badge tone="accent">online</Badge> : null}
          {device.current ? <Badge tone="attention">this device</Badge> : null}
        </>
      )}
      description={`${seen}${device.fingerprint === null ? "" : `, fingerprint ${device.fingerprint}`}`}
      title={device.label ?? device.publicId}
    >
      {device.status === "revoked"
        ? null
        : <CommandHint>{`hra device revoke ${device.publicId}`}</CommandHint>}
    </SettingsRow>
  );
}

/**
 * The settings screen.
 *
 * Self contained on purpose: it takes only `onBack`, so the router that owns
 * `#/settings` decides where back goes without this screen knowing about it.
 */
export function SettingsScreen({ onBack }: Readonly<{ onBack: () => void }>) {
  const custody = useCustody();
  const { signOut } = useAuthActions();
  const registries = useDeviceRegistries();
  const { devices, loading: devicesLoading } = useDevices();
  const serverClock = useServerClock();
  const now = serverClock.now;
  const { heads, isLoading: headsLoading, loadMore, status } = useSessionHeads(pageSize);

  const labels = useMemo(
    () => machineLabelsByDevice(registries.machines),
    [registries.machines],
  );
  const archived = useArchivedSessions(heads, labels);
  const tasks = useMemo(() => allScheduledTasks(registries.machines), [registries.machines]);
  const accounts = useMemo(() => accountRows(registries.machines), [registries.machines]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <Button aria-label="Back" onClick={onBack} size="icon" variant="ghost">
          <BackIcon />
        </Button>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>

      <main className="flex flex-1 flex-col gap-6 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <SettingsSection
          description="Each machine publishes its own defaults. A change is sent as a durable command and applies when the daemon picks it up."
          title="Machines"
        >
          {registries.error === null
            ? null
            : <p className="text-xs text-danger" role="alert">{registries.error}</p>}
          {registries.loading && registries.machines.length === 0 ? (
            <EmptyRow>Loading machines.</EmptyRow>
          ) : null}
          {!registries.loading && registries.machines.length === 0 ? (
            <SettingsCard>
              <EmptyRow>
                No machine has published its settings yet. Run hra on a machine and let it sync
                once.
              </EmptyRow>
            </SettingsCard>
          ) : null}
          {registries.machines.map((machine) => (
            <MachineCard
              key={machine.devicePublicId}
              machine={machine}
              now={now}
              target={commandTargetForMachine(heads, machine.devicePublicId)}
            />
          ))}
        </SettingsSection>

        <SettingsSection
          description="Archived sessions stay readable and can be brought back."
          title="Archived sessions"
        >
          <SettingsCard>
            {headsLoading && archived.length === 0
              ? <EmptyRow>Loading sessions.</EmptyRow>
              : null}
            {!headsLoading && archived.length === 0
              ? <EmptyRow>No archived sessions.</EmptyRow>
              : null}
            {archived.map((session) => (
              <ArchivedSessionRow key={session.publicId} now={now} session={session} />
            ))}
          </SettingsCard>
          {status === "CanLoadMore" ? (
            <Button onClick={() => { loadMore(pageSize); }} variant="secondary">
              Load more sessions
            </Button>
          ) : null}
        </SettingsSection>

        <SettingsSection
          description="Read only here. Create, edit, and delete a schedule in the session it belongs to."
          title="Scheduled tasks"
        >
          <SettingsCard>
            {tasks.length === 0 ? <EmptyRow>No scheduled tasks.</EmptyRow> : null}
            {tasks.map((task) => {
              const sessionPublicId = task.sessionPublicId;
              return (
              <SettingsRow
                control={(
                  <>
                    <Badge tone="neutral">{task.kindLabel}</Badge>
                    {sessionPublicId === null ? null : (
                      <Button
                        onClick={() => { openSession(sessionPublicId); }}
                        size="small"
                        variant="secondary"
                      >
                        Open session
                      </Button>
                    )}
                  </>
                )}
                description={`${task.machineLabel}, ${task.cadence}, next run ${task.nextRunAt === null ? "not scheduled" : formatRelativeTime(task.nextRunAt, now)}`}
                key={`${task.machineLabel}:${task.id}`}
                title={task.label}
              />
              );
            })}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          description="Accounts are linked on the machine that runs them."
          title="Accounts"
        >
          <SettingsCard>
            {accounts.length === 0 ? <EmptyRow>No accounts published yet.</EmptyRow> : null}
            {accounts.map((account) => (
              <AccountRow
                account={account}
                key={`${account.targetDevicePublicId}:${account.provider}:${account.publicId}`}
                now={now}
                serverClockReady={serverClock.ready}
              />
            ))}
            <SettingsRow
              description="Relaying a login link to this browser is off until a machine opts in."
              title="Allow linking from the browser"
            >
              <CommandHint>hra remote allow account-linking</CommandHint>
            </SettingsRow>
            <SettingsRow
              description="Codex and Claude sign in on the machine that owns their isolated provider home."
              title="Link an account from the machine"
            >
              <CommandHint>hra account login &lt;profile&gt; [--provider &lt;provider&gt;]</CommandHint>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          description="A browser device cannot administer the account, so revoke from a machine with hra installed."
          title="Devices"
        >
          <SettingsCard>
            {devicesLoading && devices.length === 0 ? <EmptyRow>Loading devices.</EmptyRow> : null}
            {devices.map((device) => (
              <DeviceRow device={device} key={device.publicId} now={now} />
            ))}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          description="Locking drops the account key from this tab. Nothing decrypts until you unlock again."
          title="This session"
        >
          <SettingsCard>
            <SettingsRow
              control={(
                <Button onClick={custody.lock} size="small" variant="secondary">Lock</Button>
              )}
              description="Also happens on idle and on Ctrl+L."
              title="Lock this tab"
            />
            <SettingsRow
              control={(
                <Button onClick={() => { void signOut(); }} size="small" variant="danger">
                  Sign out
                </Button>
              )}
              description="Ends the authentication session in this tab."
              title="Sign out"
            />
          </SettingsCard>
        </SettingsSection>
      </main>
    </div>
  );
}
