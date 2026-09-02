// Durable shapes of the macOS desktop account-switch journal. Storage persists
// them and the desktop state machine produces them; neither imports the other.

export interface DesktopProfilePaths {
  readonly profileRoot: string;
  readonly codexHome: string;
  readonly desktopUserData: string;
}

export interface DesktopSwitchGeneration {
  readonly switchGeneration: number;
  readonly sourceProfileId: string | null;
  readonly sourceProcessGeneration: number | null;
  readonly targetProfileId: string;
  readonly targetProcessGeneration: number;
}

export type DesktopSwitchStage =
  | "prepared"
  | "quit-requested"
  | "source-quiesced"
  | "launch-requested"
  | "target-observed"
  | "verified"
  | "recovery-required";

export interface DesktopSwitchJournalEntry extends DesktopSwitchGeneration {
  readonly idempotencyKey: string;
  readonly bundleCdHash: string;
  readonly sourcePid: number | null;
  readonly targetPaths: DesktopProfilePaths;
  readonly expectedAccountKey: string;
}

export interface DesktopRecoveryBinding extends DesktopSwitchGeneration {
  readonly attemptId: string;
  readonly idempotencyKey: string;
}

export type DesktopRecoveryResolution = "resolved_applied" | "resolved_not_applied";
