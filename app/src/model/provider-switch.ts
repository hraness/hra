/**
 * Switching a live session between Codex and Claude Code.
 *
 * This module is the single alignment point for the `set_provider` remote
 * command. The daemon-side kind is being added in parallel, so the payload is
 * built here and nowhere else: when the kind lands, this file is the only one
 * that changes, and `providerSwitchSupported()` flips from false to true on its
 * own because it asks the repository contract rather than a constant.
 *
 * There is no React and no Convex here. `providerSwitchNotice` is typed
 * structurally over the three fields a command record carries, the same way
 * `deviceCommandNotice` is, so the settling line is provable without a client.
 */
import { isCommandKind, type ModelPreset, type RemoteCommandPayload } from "../hra/cloud";

export type SessionProvider = "codex" | "claude";

export const providerSwitchOptions: readonly Readonly<{
  label: string;
  provider: SessionProvider;
}>[] = Object.freeze([
  { label: "Run on Codex", provider: "codex" },
  { label: "Run on Claude Code (Linux machine only)", provider: "claude" },
]);

/**
 * The one line under the menu. Switching is not a transfer of the provider's
 * own state: each provider keeps its own transcript format, its own tool
 * results, and its own reasoning, none of which the other can read. What
 * crosses is a summary the daemon writes, so the reader is told that before
 * choosing rather than after noticing the new provider has forgotten a detail.
 */
export const providerSwitchNote =
  "Switching hands the new provider a summary of the conversation so far, not the other "
  + "provider's own history. Claude targets require a Linux custodian; macOS refuses "
  + "before launching Claude.";

export const setProviderCommandKind = "set_provider";

/**
 * The one builder for the provider switch payload.
 *
 * `preset` is optional: with it, the switch and the model choice are one
 * command, so a session cannot land on the new provider under a preset that
 * provider does not have. The cast is the seam: `set_provider` is not in the
 * repository's `CommandKind` union yet, and this assertion is the only place
 * the two shapes meet.
 */
export function buildSetProviderPayload(input: Readonly<{
  preset?: ModelPreset;
  provider: SessionProvider;
}>): RemoteCommandPayload {
  const payload: Readonly<{
    kind: string;
    preset?: ModelPreset;
    provider: SessionProvider;
  }> = input.preset === undefined
    ? { kind: setProviderCommandKind, provider: input.provider }
    : { kind: setProviderCommandKind, preset: input.preset, provider: input.provider };
  return payload as unknown as RemoteCommandPayload;
}

/**
 * Whether the contract in this build carries the switch.
 *
 * `isCommandKind` is the repository's own closed list, so this is not a guess:
 * a build whose daemon cannot accept the command says so in the menu instead of
 * enqueueing something that would be refused after the round trip.
 */
export function providerSwitchSupported(): boolean {
  return isCommandKind(setProviderCommandKind);
}

/**
 * Why the switch is unavailable right now, or null when it can be taken.
 *
 * A switch mid-turn would race the provider that is writing, so it waits for
 * the turn to finish rather than racing it.
 */
export function providerSwitchDisabledReason(input: Readonly<{
  sending: boolean;
  /** `providerSwitchSupported()`, passed in so this stays a pure function. */
  supported: boolean;
  turnActive: boolean;
}>): string | null {
  if (!input.supported) {
    return "This build's daemon contract does not carry a provider switch yet.";
  }
  if (input.turnActive) return "Stop the turn first, then switch.";
  if (input.sending) return "A command is already going out.";
  return null;
}

export type ProviderSwitchNotice = Readonly<{
  settled: boolean;
  text: string;
}>;

/**
 * The one line the menu shows for the switch it last submitted.
 *
 * An ambiguous outcome is never phrased as a failure: the daemon may have
 * switched and lost the confirmation, so the honest instruction is to look at
 * the session rather than to send it again.
 */
export function providerSwitchNotice(
  command: Readonly<{ resultCode: string | null; state: string }> | null,
  provider: SessionProvider | null,
): ProviderSwitchNotice | null {
  if (command === null || provider === null) return null;
  const name = provider === "claude" ? "Claude Code" : "Codex";
  switch (command.state) {
    case "pending":
      return { settled: false, text: `Waiting for the machine to pick up the switch to ${name}.` };
    case "prepared":
    case "effect_started":
      return { settled: false, text: `Switching this session to ${name}.` };
    case "applied":
      return { settled: true, text: `This session is running on ${name}.` };
    case "ambiguous":
      return {
        settled: true,
        text: "The machine could not confirm the switch. Check the session before trying again.",
      };
    case "expired":
      return { settled: true, text: "The machine never picked up the switch." };
    case "cancelled":
      return { settled: true, text: "The switch was cancelled." };
    case "failed":
      return {
        settled: true,
        text: command.resultCode === null
          ? "The machine refused the switch."
          : `The machine refused the switch: ${command.resultCode}.`,
      };
    default:
      return { settled: false, text: `Switching this session to ${name}.` };
  }
}
