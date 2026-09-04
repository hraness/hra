/**
 * The settings screen's command builders.
 *
 * Every control on the settings screen submits one `RemoteCommandPayload`
 * through the ordinary durable command path, so the shape of each payload is
 * built here rather than inline in a component: the daemon's validator in
 * `src/cloud/payloads.ts` is a closed union with exact key sets, and a builder
 * that drifts from it fails at the daemon rather than at the browser.
 *
 * Daemon-wide settings are session-addressed like every other command (the
 * command table is indexed by session), so the caller sends them to any live
 * session that belongs to the target machine and the `scope: "default"` field
 * is what makes them daemon defaults rather than session overrides.
 *
 * Nothing here imports React, so `bun test ./app` runs it without a document.
 */
import type { RemoteCommandPayload } from "../hra/cloud";

export type ApprovalMode = "auto:all" | "auto:workspace" | "manual";
export type PresetChoice = "low" | "high" | "ultra" | "fable-max";

/** The scope every machine-level control on this screen uses. */
export const defaultSettingScope = "default" as const;

export const approvalModes: readonly ApprovalMode[] = Object.freeze([
  "auto:all",
  "auto:workspace",
  "manual",
] as const);

export const approvalModeLabels: Readonly<Record<ApprovalMode, string>> = Object.freeze({
  "auto:all": "Auto, all",
  "auto:workspace": "Auto, workspace",
  manual: "Manual",
});

export const presetChoices: readonly PresetChoice[] = Object.freeze([
  "low",
  "high",
  "ultra",
  "fable-max",
] as const);

export const presetLabels: Readonly<Record<PresetChoice, string>> = Object.freeze({
  "fable-max": "Fable Max",
  high: "High",
  low: "Low",
  ultra: "Ultra",
});

export function approvalModeCommand(mode: ApprovalMode): RemoteCommandPayload {
  return { kind: "set_approval_mode", mode, scope: defaultSettingScope };
}

export function showThinkingCommand(enabled: boolean): RemoteCommandPayload {
  return { enabled, kind: "set_show_thinking", scope: defaultSettingScope };
}

export function defaultPresetCommand(preset: PresetChoice): RemoteCommandPayload {
  return { kind: "set_default_preset", preset };
}

/** Unarchive is session scoped: it addresses the archived session itself. */
export function unarchiveSessionCommand(): RemoteCommandPayload {
  return { archived: false, kind: "archive_session" };
}

export const gatewayKeyMinimumLength = 8;
export const gatewayKeyMaximumLength = 512;

/*
 * The daemon accepts 8 to 512 printable ASCII characters with no space
 * (`isGatewayKeyShape` in `src/cloud/payloads.ts`). The check is repeated here
 * so a mistyped value is refused in the browser instead of travelling to the
 * daemon, and it is a shape check only: the value itself is never logged,
 * echoed into a notice, or held anywhere but the controlled input it came from.
 */
const gatewayKeyCharacters = /^[!-~]+$/u;

export function isGatewayKeyShape(value: string): boolean {
  return value.length >= gatewayKeyMinimumLength
    && value.length <= gatewayKeyMaximumLength
    && gatewayKeyCharacters.test(value);
}

export const gatewayKeyShapeMessage =
  `A gateway key is ${gatewayKeyMinimumLength} to ${gatewayKeyMaximumLength} `
  + "printable characters with no space.";

export function gatewayKeyCommand(key: string): RemoteCommandPayload {
  if (!isGatewayKeyShape(key)) throw new Error(gatewayKeyShapeMessage);
  return { key, kind: "set_gateway_key" };
}

/** The human-readable name of a control, used only for its progress notice. */
export const settingsCommandLabels: Readonly<Record<string, string>> = Object.freeze({
  archive_session: "Unarchive",
  set_approval_mode: "Approval mode",
  set_default_preset: "Default preset",
  set_gateway_key: "Gateway key",
  set_show_thinking: "Show thinking",
});

export function settingsCommandLabel(kind: string): string {
  return settingsCommandLabels[kind] ?? "Setting";
}
