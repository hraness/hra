import {
  deviceCommandLoginResultLifetimeMs,
  deviceCommandLimits,
  parseDeviceCommandPayload,
  type DeviceCommandPayload,
  type DeviceCommandResultPayload,
} from "../hra/cloud";
import type { MachineView } from "./settings-view";

/**
 * Builders for the four device commands, plus the small derivations the grid
 * composer and the settings linking flow need.
 *
 * Every builder runs its output through the daemon's own parser, so a builder
 * that adds or drops a field fails here rather than at the machine.
 */

export type PresetChoice = "low" | "high" | "ultra";

/** The UI default the plan names: Sol Ultra. */
export const defaultSessionStartPreset: PresetChoice = "ultra";

export type SessionStartTarget = Readonly<{
  accountLabel: string;
  accountPublicId: string;
  deviceCommandsAllowed: boolean;
  machineLabel: string;
  machineOnline: boolean;
  projects: readonly Readonly<{ label: string; publicId: string }>[];
  provider: "codex" | "claude";
  targetDevicePublicId: string;
}>;

/** Public picker copy cannot infer OS, so it states Claude's admission boundary beside the choice. */
export function sessionStartTargetLabel(target: SessionStartTarget): string {
  const provider = target.provider === "claude"
    ? "Claude Code (Linux machine only)"
    : "Codex";
  return `${target.accountLabel} — ${target.machineLabel} — ${provider}`;
}

/** The composer repeats the boundary after selection, before any remote provider effect. */
export function sessionStartTargetHint(target: SessionStartTarget): string {
  const availability = target.machineOnline
    ? ""
    : " (offline; it will run when the machine wakes)";
  const platform = target.provider === "claude"
    ? " Claude sessions require a Linux custodian; macOS refuses before launch."
    : "";
  return `Starts on ${target.machineLabel}${availability}.${platform}`;
}

function build(payload: DeviceCommandPayload): DeviceCommandPayload {
  const parsed = parseDeviceCommandPayload(payload);
  if (parsed === null) throw new Error("The device command payload is not valid.");
  return parsed;
}

export function sessionStartCommand(input: Readonly<{
  accountPublicId: string;
  preset: PresetChoice;
  projectPublicId: string;
  prompt: string;
  provider: "codex" | "claude";
}>): DeviceCommandPayload {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new Error("A new session needs a prompt.");
  if (prompt.length > deviceCommandLimits.promptCharacters) {
    throw new Error("That prompt is too long to start a session with.");
  }
  return build({
    accountPublicId: input.accountPublicId,
    kind: "session_start",
    preset: input.preset,
    projectPublicId: input.projectPublicId,
    prompt,
    provider: input.provider,
  });
}

export function accountLoginStartCommand(accountPublicId: string): DeviceCommandPayload {
  return build({ accountPublicId, handoffVersion: 2, kind: "account_login_start" });
}

export function accountLoginStatusCommand(accountPublicId: string): DeviceCommandPayload {
  return build({ accountPublicId, kind: "account_login_status" });
}

/**
 * Replaces the daemon-clock expiry with the hosted settlement deadline.
 * Convex owns this timestamp so machine and browser clock skew cannot hide a
 * freshly released code or extend its five-minute readable window.
 */
export function bindHostedLoginResultExpiry(
  result: DeviceCommandResultPayload,
  expiresAt: unknown,
  fallbackExpiresAt?: unknown,
): DeviceCommandResultPayload | null {
  const effectiveExpiresAt = Number.isSafeInteger(expiresAt) && (expiresAt as number) > 0
    ? expiresAt
    : fallbackExpiresAt;
  if (
    result.kind !== "account_login_start"
    || !Number.isSafeInteger(effectiveExpiresAt)
    || (effectiveExpiresAt as number) <= 0
  ) return null;
  return { ...result, expiresAt: effectiveExpiresAt as number };
}

/** Server-owned deadline derivable from the public command settlement row. */
export function hostedLoginHandoffDeadline(settledAt: unknown): number | null {
  if (!Number.isSafeInteger(settledAt) || (settledAt as number) < 0) return null;
  const deadline = (settledAt as number) + deviceCommandLoginResultLifetimeMs;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

export type HostedLoginHandoffAdmission =
  | Readonly<{ status: "awaiting_server_clock" }>
  | Readonly<{ status: "expired_or_invalid" }>
  | Readonly<{ expiresAt: number; status: "ready" }>;

/**
 * Admit a single-use result only after the browser clock is server-anchored.
 * An ahead local clock must not permanently consume or dismiss a fresh code
 * during the render before `presence:current` establishes its offset.
 */
export function admitHostedLoginHandoff(input: Readonly<{
  now: number;
  serverClockReady: boolean;
  settledAt: unknown;
}>): HostedLoginHandoffAdmission {
  if (!input.serverClockReady) return { status: "awaiting_server_clock" };
  const expiresAt = hostedLoginHandoffDeadline(input.settledAt);
  return expiresAt === null || expiresAt <= input.now
    ? { status: "expired_or_invalid" }
    : { expiresAt, status: "ready" };
}

export function usageRefreshCommand(): DeviceCommandPayload {
  return build({ kind: "usage_refresh" });
}

/**
 * Every account a browser could start a session on, paired with the machine
 * that owns it and that machine's projects. An account that is not signed in,
 * a machine with no projects, and a machine whose kill switch is set all stay
 * out: the picker never offers a target the daemon would refuse.
 */
export function sessionStartTargets(
  machines: readonly MachineView[],
): readonly SessionStartTarget[] {
  const targets: SessionStartTarget[] = [];
  for (const machine of machines) {
    if (!machine.deviceCommandsAllowed) continue;
    if (machine.projects.length === 0) continue;
    for (const account of machine.accounts) {
      if (account.status !== "signed_in") continue;
      targets.push({
        accountLabel: account.label,
        accountPublicId: account.publicId,
        deviceCommandsAllowed: true,
        machineLabel: machine.label,
        machineOnline: machine.online,
        projects: machine.projects,
        provider: account.provider,
        targetDevicePublicId: machine.devicePublicId,
      });
    }
  }
  // A machine that has not heartbeated recently is still offered, but last:
  // its commands queue until it wakes rather than failing.
  return targets.sort((left, right) => {
    if (left.machineOnline !== right.machineOnline) return left.machineOnline ? -1 : 1;
    return left.machineLabel.localeCompare(right.machineLabel)
      || left.accountLabel.localeCompare(right.accountLabel);
  });
}

export type DeviceCommandNotice = Readonly<{ tone: "error" | "pending" | "settled"; text: string }>;

const refusalNotices: Readonly<Record<string, string>> = {
  ACCOUNT_LINKING_DENIED:
    "Account linking from the browser is off on that machine. Run `hra remote allow account-linking` there first.",
  ACCOUNT_LOGIN_RELAY_UNAVAILABLE:
    "That machine could not relay a login link. Run `hra account login <account>` on the machine instead.",
  DEVICE_COMMANDS_DENIED:
    "That machine is not accepting commands from other devices. Run `hra remote allow device-commands` there.",
  DEVICE_COMMAND_ACCOUNT_SIGNED_OUT: "That account is signed out on the machine.",
  DEVICE_COMMAND_ACCOUNT_UNKNOWN: "That machine no longer has that account.",
  DEVICE_COMMAND_DAILY_CAP: "This device has reached its daily limit on that machine.",
  DEVICE_COMMAND_PROJECT_UNKNOWN: "That machine no longer has that project.",
  DEVICE_COMMAND_PROVIDER_UNSUPPORTED: "That account is not the provider this request named.",
  REQUESTING_DEVICE_INACTIVE: "This device is no longer active on the account.",
};

/**
 * The one line the UI shows for a device command's current state. An ambiguous
 * outcome is deliberately never phrased as a failure: the effect may have
 * happened, and the honest instruction is to look rather than to retry.
 */
export function deviceCommandNotice(command: Readonly<{
  kind: string;
  resultCode: string | null;
  state: string;
}> | null): DeviceCommandNotice | null {
  if (command === null) return null;
  switch (command.state) {
    case "pending":
      return { text: "Waiting for the machine to pick this up…", tone: "pending" };
    case "prepared":
    case "effect_started":
      return { text: "Running on the machine…", tone: "pending" };
    case "applied":
      return command.kind === "session_start"
        ? { text: "Started. The new session appears here shortly.", tone: "settled" }
        : { text: "Done.", tone: "settled" };
    case "ambiguous":
      return {
        text: command.kind === "session_start"
          ? "The machine could not confirm whether the session started. Check the grid before trying again."
          : "The machine could not confirm the outcome. Check the machine before trying again.",
        tone: "error",
      };
    case "expired":
      return { text: "The machine never picked this up.", tone: "error" };
    case "cancelled":
      return { text: "Cancelled.", tone: "error" };
    case "failed":
      return {
        text: (command.resultCode === null ? undefined : refusalNotices[command.resultCode])
          ?? "The machine refused this request.",
        tone: "error",
      };
    default:
      return null;
  }
}
