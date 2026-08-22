import type { WorkspaceLaneIdentity } from "./workspace-broker";

export interface WorkspaceSetupGate {
  beforeWorkspaceReady(input: WorkspaceLaneIdentity): Promise<void>;
}

export type WorkspaceSetupDeferredState =
  | "approval_required"
  | "effect_started"
  | "failed"
  | "ambiguous";

/** Safe, renderer-projectable coordinates for one deferred setup request. */
export class WorkspaceSetupDeferredError extends Error {
  readonly recipeDigest: string;
  readonly requestId: string;
  readonly setupRevision: number;
  readonly state: WorkspaceSetupDeferredState;

  constructor(input: Readonly<{
    recipeDigest: string;
    requestId: string;
    setupRevision: number;
    state: WorkspaceSetupDeferredState;
  }>) {
    super(input.state === "approval_required"
      ? "Workspace setup requires approval"
      : input.state === "effect_started"
      ? "Workspace setup is already in progress"
      : input.state === "failed"
      ? "Workspace setup failed"
      : "Workspace setup outcome is ambiguous");
    this.name = "WorkspaceSetupDeferredError";
    this.recipeDigest = input.recipeDigest;
    this.requestId = input.requestId;
    this.setupRevision = input.setupRevision;
    this.state = input.state;
  }
}
