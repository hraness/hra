/**
 * The settings screen's view models.
 *
 * One decrypted `DeviceRegistryPayload` plus the device row it belongs to
 * becomes one machine card; every machine's scheduled tasks are flattened into
 * one read-only list; and the session heads whose decrypted metadata says
 * `archived` become the unarchive list. All of it is a pure fold, so
 * `bun test ./app` checks the derivations without a document, a network, or an
 * account key.
 */
import type {
  DeviceRegistryAccount,
  DeviceRegistryPayload,
  DeviceRegistryProject,
  DeviceRegistryScheduledTask,
  NotificationHoursPolicy,
} from "../hra/cloud";
import type { ApprovalMode, PresetChoice } from "./settings-commands";

/**
 * `deviceRegistryHeartbeatMs` in `src/cloud/daemon-bridge.ts`: a daemon
 * republishes its registry when an input changed and otherwise once a minute.
 */
export const registryHeartbeatIntervalMs = 60_000;

/** Three missed registry heartbeats before a machine reads as offline. */
export const registryHeartbeatToleranceMs = 3 * registryHeartbeatIntervalMs;

export type MachineDeviceState = Readonly<{
  online: boolean;
  status: "pending" | "active" | "revoked";
}>;

export type MachineOnlineInput = Readonly<{
  /** The registry's own device row from `devices:list`, or null when it is gone. */
  device: MachineDeviceState | null;
  heartbeatAt: number;
  now: number;
}>;

/**
 * A machine is online when the hosted presence table still holds its device
 * connection, and otherwise when its registry heartbeat is recent enough that
 * presence has simply not caught up. A revoked or missing device row is always
 * offline, whatever the last published heartbeat said.
 */
export function isMachineOnline(input: MachineOnlineInput): boolean {
  const { device, heartbeatAt, now } = input;
  if (device === null || device.status !== "active") return false;
  if (device.online) return true;
  if (!Number.isFinite(heartbeatAt) || heartbeatAt <= 0 || !Number.isFinite(now)) return false;
  return now - heartbeatAt <= registryHeartbeatToleranceMs;
}

export type ScheduledTaskKindLabel = "Codex" | "HRA";

export function scheduledTaskKindLabel(
  kind: DeviceRegistryScheduledTask["kind"],
): ScheduledTaskKindLabel {
  return kind === "codex_automation" ? "Codex" : "HRA";
}

export type ScheduledTaskView = Readonly<{
  cadence: string;
  id: string;
  kind: DeviceRegistryScheduledTask["kind"];
  kindLabel: ScheduledTaskKindLabel;
  label: string;
  machineLabel: string;
  nextRunAt: number | null;
  sessionPublicId: string | null;
}>;

export type MachineView = Readonly<{
  // Local switches as this machine last published them. A registry written
  // before device commands existed reads as the shipped defaults: commands
  // allowed and linking denied. Email absence never reads as enabled.
  accountLinkingAllowed: boolean;
  accounts: readonly DeviceRegistryAccount[];
  /** Null unless the composite hosted freshness fence matches decrypted policy. */
  attentionEmailEnabled: boolean | null;
  daemonVersion: string;
  defaultApprovalMode: ApprovalMode;
  defaultPreset: PresetChoice;
  deviceCommandsAllowed: boolean;
  devicePublicId: string;
  /** Current hosted device authority; a stale registry can outlive this row. */
  deviceStatus: MachineDeviceState["status"] | null;
  heartbeatAt: number;
  label: string;
  online: boolean;
  notificationHours: NotificationHoursPolicy | null;
  notificationHoursStatus: "available" | "unreadable" | "unsupported";
  notificationPolicyFreshness: "current" | "stale" | "unreadable" | "unsupported";
  notificationPolicyRevision: number | null;
  projects: readonly DeviceRegistryProject[];
  proseAutorespondConfigured: boolean;
  revision: number;
  scheduledTasks: readonly ScheduledTaskView[];
  showThinkingDefault: boolean;
  updatedAt: number;
}>;

export type MachineViewInput = Readonly<{
  attentionEmailEnabled?: boolean | null;
  device: MachineDeviceState | null;
  devicePublicId: string;
  now: number;
  notificationHours?: NotificationHoursPolicy | null;
  notificationHoursStatus?: MachineView["notificationHoursStatus"];
  notificationPolicyFreshness?: MachineView["notificationPolicyFreshness"];
  notificationPolicyRevision?: number | null;
  payload: DeviceRegistryPayload;
  revision: number;
  updatedAt: number;
}>;

export function toMachineView(input: MachineViewInput): MachineView {
  const { payload } = input;
  return {
    accountLinkingAllowed: payload.accountLinkingAllowed ?? false,
    accounts: payload.accounts,
    attentionEmailEnabled: input.attentionEmailEnabled ?? null,
    daemonVersion: payload.daemonVersion,
    defaultApprovalMode: payload.defaultApprovalMode,
    defaultPreset: payload.defaultPreset,
    deviceCommandsAllowed: payload.deviceCommandsAllowed ?? true,
    devicePublicId: input.devicePublicId,
    deviceStatus: input.device?.status ?? null,
    heartbeatAt: payload.heartbeatAt,
    label: payload.machineLabel,
    online: isMachineOnline({
      device: input.device,
      heartbeatAt: payload.heartbeatAt,
      now: input.now,
    }),
    projects: payload.projects,
    proseAutorespondConfigured: payload.proseAutorespondConfigured,
    revision: input.revision,
    scheduledTasks: payload.scheduledTasks.map((task) => ({
      cadence: task.cadence,
      id: task.id,
      kind: task.kind,
      kindLabel: scheduledTaskKindLabel(task.kind),
      label: task.label,
      machineLabel: payload.machineLabel,
      nextRunAt: task.nextRunAt,
      sessionPublicId: task.sessionPublicId,
    })),
    showThinkingDefault: payload.showThinkingDefault,
    notificationHours: input.notificationHours ?? null,
    notificationHoursStatus: input.notificationHoursStatus
      ?? (input.notificationHours == null ? "unsupported" : "available"),
    notificationPolicyFreshness: input.notificationPolicyFreshness ?? "unsupported",
    notificationPolicyRevision: input.notificationPolicyRevision ?? null,
    updatedAt: input.updatedAt,
  };
}

export type AttentionEmailPresentation = Readonly<{
  description: string;
  label: "disabled" | "enabled" | "refresh needed" | "unavailable";
  tone: "accent" | "attention" | "neutral";
}>;

/** Read-only copy for the settings row; this function grants no command authority. */
export function attentionEmailPresentation(
  machine: Pick<
    MachineView,
    "attentionEmailEnabled" | "notificationPolicyFreshness" | "notificationPolicyRevision"
  >,
): AttentionEmailPresentation {
  if (
    machine.notificationPolicyFreshness === "current"
    && machine.notificationPolicyRevision !== null
    && machine.attentionEmailEnabled !== null
  ) {
    return {
      description: `Last published local email opt-in at notification policy revision ${machine.notificationPolicyRevision}.`,
      label: machine.attentionEmailEnabled ? "enabled" : "disabled",
      tone: machine.attentionEmailEnabled ? "accent" : "neutral",
    };
  }
  if (machine.notificationPolicyFreshness === "stale") {
    return {
      description: "The encrypted setting and hosted policy revision do not match yet.",
      label: "refresh needed",
      tone: "attention",
    };
  }
  if (machine.notificationPolicyFreshness === "unreadable") {
    return {
      description: "This machine’s email opt-in projection could not be verified.",
      label: "unavailable",
      tone: "attention",
    };
  }
  return {
    description: "Unavailable on this machine’s current daemon.",
    label: "unavailable",
    tone: "neutral",
  };
}

/** Online machines first, then by label, then by device id so ties are stable. */
export function sortMachines(machines: readonly MachineView[]): readonly MachineView[] {
  return [...machines].sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    const byLabel = left.label.localeCompare(right.label);
    return byLabel === 0 ? left.devicePublicId.localeCompare(right.devicePublicId) : byLabel;
  });
}

/**
 * Every machine's scheduled tasks in one list, soonest run first. A task with no
 * next run is not overdue, it is simply unscheduled, so it sorts last.
 */
export function allScheduledTasks(
  machines: readonly MachineView[],
): readonly ScheduledTaskView[] {
  return machines
    .flatMap((machine) => machine.scheduledTasks)
    .sort((left, right) => {
      if (left.nextRunAt === right.nextRunAt) return left.label.localeCompare(right.label);
      if (left.nextRunAt === null) return 1;
      if (right.nextRunAt === null) return -1;
      return left.nextRunAt - right.nextRunAt;
    });
}

export function machineLabelsByDevice(
  machines: readonly MachineView[],
): ReadonlyMap<string, string> {
  return new Map(machines.map((machine) => [machine.devicePublicId, machine.label]));
}

export type SessionHeadSummary = Readonly<{
  executionDevicePublicId: string;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
}>;

export type CommandTarget = Readonly<{
  executionDevicePublicId: string;
  sessionPublicId: string;
}>;

/**
 * Where a machine-wide setting command is sent.
 *
 * Commands are session-indexed and the hosted validator refuses a session in a
 * terminal or orphaned state, so a daemon default is addressed to the machine's
 * most recently updated live session. A machine with no live session cannot be
 * configured from the browser at all, and the caller says so instead of
 * enqueuing a command that would be rejected.
 */
export function commandTargetForMachine(
  heads: readonly SessionHeadSummary[],
  devicePublicId: string,
): CommandTarget | null {
  let best: SessionHeadSummary | null = null;
  for (const head of heads) {
    if (head.executionDevicePublicId !== devicePublicId) continue;
    if (head.state === "terminal" || head.state === "orphaned") continue;
    if (best === null || head.updatedAt > best.updatedAt) best = head;
  }
  return best === null
    ? null
    : { executionDevicePublicId: best.executionDevicePublicId, sessionPublicId: best.publicId };
}

export type ArchivedSessionInput = Readonly<{
  executionDevicePublicId: string;
  metadata: Readonly<{ archived?: boolean; name: string | null }> | null;
  publicId: string;
  updatedAt: number;
}>;

export type ArchivedSessionView = Readonly<{
  executionDevicePublicId: string;
  machineLabel: string | null;
  publicId: string;
  title: string;
  updatedAt: number;
}>;

export const shortIdCharacters = 12;

export function shortSessionId(publicId: string): string {
  return publicId.slice(0, shortIdCharacters);
}

/**
 * The archived list. `archived` lives in the encrypted session metadata, so a
 * head whose metadata has not decrypted yet is simply absent rather than
 * guessed at, and the newest archived session sorts first.
 */
export function archivedSessionRows(
  sessions: readonly ArchivedSessionInput[],
  machineLabels: ReadonlyMap<string, string>,
): readonly ArchivedSessionView[] {
  return sessions
    .filter((session) => session.metadata?.archived === true)
    .map((session) => ({
      executionDevicePublicId: session.executionDevicePublicId,
      machineLabel: machineLabels.get(session.executionDevicePublicId) ?? null,
      publicId: session.publicId,
      title: session.metadata?.name ?? shortSessionId(session.publicId),
      updatedAt: session.updatedAt,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export type AccountRowView = Readonly<{
  /** The machine's local opt-in: `hra remote allow account-linking`. */
  accountLinkingAllowed: boolean;
  /** The machine-wide device-command kill switch. */
  deviceCommandsAllowed: boolean;
  label: string;
  machineLabel: string;
  provider: DeviceRegistryAccount["provider"];
  publicId: string;
  status: DeviceRegistryAccount["status"];
  targetDevicePublicId: string;
}>;

export const accountStatusLabels: Readonly<
  Record<DeviceRegistryAccount["status"], string>
> = Object.freeze({
  login_pending: "Login pending",
  recovery_required: "Recovery required",
  signed_in: "Signed in",
  signed_out: "Signed out",
});

export function accountRows(machines: readonly MachineView[]): readonly AccountRowView[] {
  return machines.flatMap((machine) => machine.accounts.map((account) => ({
    accountLinkingAllowed: machine.accountLinkingAllowed,
    deviceCommandsAllowed: machine.deviceCommandsAllowed,
    label: account.label,
    machineLabel: machine.label,
    provider: account.provider,
    publicId: account.publicId,
    status: account.status,
    targetDevicePublicId: machine.devicePublicId,
  })));
}

/** Browser login controls exist only when both local machine gates admit them. */
export function accountBrowserLoginAllowed(account: AccountRowView): boolean {
  return account.provider === "codex"
    && account.deviceCommandsAllowed
    && account.accountLinkingAllowed;
}
