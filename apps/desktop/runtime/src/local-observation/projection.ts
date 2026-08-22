import {
  canonicalLocalPaneListProjection,
  localPaneListLimit,
  type LocalPaneListProjection,
} from "@hraness/hra-local-observation-protocol/panes";

export interface GatewayPaneObservationSource {
  readonly id: string;
  readonly title: string;
  readonly repository: Readonly<{ readonly name: string }>;
  readonly interactionMode: "chat" | "harnessObserver";
  readonly state: "ready" | "starting" | "streaming" | "continuing" | "attention";
  readonly workspace: Readonly<{
    readonly state:
      | "preparing"
      | "waitingCapacity"
      | "ready"
      | "preserved"
      | "recoveryRequired";
    readonly recoveryKind:
      | "legacyUnbound"
      | "capacityUnavailable"
      | "insufficientDisk"
      | "baseMismatch"
      | "bindingMismatch"
      | "branchWithoutLane"
      | "checkoutMismatch"
      | "dirtyCheckout"
      | "invalidManifest"
      | "manifestMissing"
      | "pathEscape"
      | "repositoryMismatch"
      | "provisionInterrupted"
      | "laneMissing"
      | "unknown"
      | null;
  }> | null;
  readonly messageQueue: Readonly<{
    readonly pauseReason: string | null;
    readonly blockedMessage: object | null;
    readonly messages: readonly unknown[];
  }>;
  readonly schedule: Readonly<{ readonly nextRunAt: string }> | null;
}

const localDisplayNameByteLimit = 160;
const encoder = new TextEncoder();

function safeDisplayText(value: string, fallback: string): string {
  const trimmed = value.trim();
  const source = trimmed.length === 0 || trimmed.includes("\0")
    ? fallback
    : trimmed;
  let result = "";
  let byteLength = 0;
  for (const character of source) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const characterByteLength = encoder.encode(character).byteLength;
    if (byteLength + characterByteLength > localDisplayNameByteLimit) break;
    result += character;
    byteLength += characterByteLength;
  }
  return result.length === 0 ? fallback : result;
}

/**
 * Construct a new minimized value from an already validated live pane list.
 * Extra source fields are deliberately unreachable from the output object.
 */
export function projectFreshLocalPaneList(
  sources: readonly GatewayPaneObservationSource[],
): LocalPaneListProjection {
  const panes = sources.slice(0, localPaneListLimit).map((source) => {
    const blocked = source.messageQueue.blockedMessage !== null;
    return {
      paneId: source.id,
      title: safeDisplayText(source.title, "Untitled pane"),
      repositoryName: safeDisplayText(source.repository.name, "Repository"),
      interactionMode: source.interactionMode,
      state: source.state,
      workspace: source.workspace === null
        ? null
        : {
            state: source.workspace.state,
            recoveryKind: source.workspace.recoveryKind,
          },
      queue: {
        count: {
          value: source.messageQueue.messages.length + (blocked ? 1 : 0),
          capped: false,
        },
        paused: source.messageQueue.pauseReason !== null,
        blocked,
      },
      schedule: source.schedule === null
        ? null
        : { nextRunAt: source.schedule.nextRunAt },
    };
  });
  return canonicalLocalPaneListProjection({
    version: 1,
    panes,
    truncated: sources.length > localPaneListLimit,
  });
}
