import { createHash } from "node:crypto";

import type {
  DispatchBinding,
  DispatchReservation,
} from "../state/dispatch-store";
import type { ManagedWorkspace } from "../workspaces/workspace-broker";
import type {
  DispatchStage,
  PublicRunEventKind,
} from "./model";

export interface DispatchAssignment extends DispatchReservation {
  readonly accountProfileId: string;
  readonly baseRef: string;
  readonly initialPrompt: string;
  readonly repositoryPath: string;
  readonly title: string;
}

export interface DispatchCoordinatorStore {
  reserve(input: DispatchReservation): DispatchBinding;
  read(runId: string): DispatchBinding | null;
  transition(input: {
    readonly runId: string;
    readonly to: DispatchStage;
    readonly accountProfileId?: string;
    readonly laneId?: string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly baseSha?: string;
    readonly branchName?: string;
    readonly failureCode?: string;
  }): DispatchBinding;
  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
  }): { readonly sequence: number };
}

export interface DispatchPublicationBarrier {
  acknowledgeThrough(
    runId: string,
    throughSequence: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface DispatchWorkspacePort {
  resolveBase(repositoryPath: string, baseRef: string): Promise<string>;
  provision(input: {
    readonly runId: string;
    readonly repositoryPath: string;
    readonly baseSha: string;
  }): Promise<ManagedWorkspace>;
}

export type ReconciledExternalMutation<T> =
  | Readonly<{ kind: "ready"; value: T }>
  | Readonly<{ kind: "ambiguous" }>;

export interface CodexDispatchLauncher {
  ensureThread(input: {
    readonly accountProfileId: string;
    readonly runId: string;
    readonly title: string;
    readonly workspacePath: string;
  }): Promise<ReconciledExternalMutation<{ readonly threadId: string }>>;
  ensureInitialTurn(input: {
    readonly clientUserMessageId: string;
    readonly initialPrompt: string;
    readonly runId: string;
    readonly threadId: string;
  }): Promise<ReconciledExternalMutation<{ readonly turnId: string }>>;
}

export interface DispatchFenceGuard {
  assertCurrent(input: {
    readonly claimFence: number;
    readonly claimId: string;
    readonly runId: string;
    readonly runtimeBootId: string;
    readonly runtimePublicId: string;
  }): Promise<boolean>;
}

export type DispatchExecutionResult =
  | Readonly<{ kind: "running"; binding: DispatchBinding }>
  | Readonly<{ kind: "terminal"; binding: DispatchBinding }>
  | Readonly<{ kind: "ambiguous"; binding: DispatchBinding }>
  | Readonly<{ kind: "lease_lost"; binding: DispatchBinding }>;

export class DispatchCoordinator {
  readonly #fence: DispatchFenceGuard;
  readonly #launcher: CodexDispatchLauncher;
  readonly #publication: DispatchPublicationBarrier;
  readonly #store: DispatchCoordinatorStore;
  readonly #workspaces: DispatchWorkspacePort;

  constructor(options: {
    readonly fence: DispatchFenceGuard;
    readonly launcher: CodexDispatchLauncher;
    readonly publication: DispatchPublicationBarrier;
    readonly store: DispatchCoordinatorStore;
    readonly workspaces: DispatchWorkspacePort;
  }) {
    this.#fence = options.fence;
    this.#launcher = options.launcher;
    this.#publication = options.publication;
    this.#store = options.store;
    this.#workspaces = options.workspaces;
  }

  async execute(
    assignment: DispatchAssignment,
    signal?: AbortSignal,
  ): Promise<DispatchExecutionResult> {
    let binding = this.#store.reserve(assignment);
    if (isTerminal(binding.stage)) {
      const terminalEvent = terminalEventFor(binding.stage);
      if (terminalEvent !== null) this.#event(binding.runId, terminalEvent.ordinal, terminalEvent.kind);
      return { kind: "terminal", binding: this.#store.read(binding.runId) ?? binding };
    }
    if (binding.stage === "ambiguous") {
      this.#event(binding.runId, 8, "run.lease_lost");
      return { kind: "ambiguous", binding: this.#store.read(binding.runId) ?? binding };
    }
    if (aborted(signal) || !(await this.#hasFence(assignment))) {
      return this.#loseLease(binding);
    }
    if (binding.executionMode !== "managed_worktree") {
      return this.#markAmbiguous(
        binding,
        "retired_development_source_binding",
      );
    }

    try {
      let reconciledThread: ReconciledExternalMutation<{ readonly threadId: string }> | null = null;
      if (binding.stage === "reserved") {
        this.#event(binding.runId, 1, "run.queued");
        const preparing = this.#event(binding.runId, 2, "worktree.preparing");
        if (!(await this.#acknowledge(binding, preparing.sequence, signal))) {
          return this.#loseLease(binding);
        }
        const baseSha = binding.baseSha ?? await this.#workspaces.resolveBase(
          assignment.repositoryPath,
          assignment.baseRef,
        );
        const workspace = await this.#workspaces.provision({
          runId: assignment.runId,
          repositoryPath: assignment.repositoryPath,
          baseSha,
        });
        if (aborted(signal) || !(await this.#hasFence(assignment))) {
          return this.#loseLease(binding);
        }
        binding = this.#store.transition({
          runId: binding.runId,
          to: "worktree_ready",
          accountProfileId: assignment.accountProfileId,
          baseSha: workspace.baseSha,
          branchName: workspace.branchName,
          laneId: workspace.laneId,
        });
      }

      if (binding.stage === "worktree_ready") this.#event(binding.runId, 3, "worktree.ready");
      const workspace = await this.#recoverWorkspace(assignment, binding);
      if (aborted(signal) || !(await this.#hasFence(assignment))) {
        return this.#loseLease(binding);
      }
      if (binding.stage === "worktree_ready") {
        binding = this.#store.transition({ runId: binding.runId, to: "thread_starting" });
      }
      if (
        binding.stage === "thread_starting"
        || binding.stage === "thread_ready"
        || binding.stage === "turn_starting"
      ) {
        const starting = this.#event(binding.runId, 4, "codex.starting");
        if (!(await this.#acknowledge(binding, starting.sequence, signal))) {
          return this.#loseLease(binding);
        }
      }

      if (binding.stage === "thread_starting") {
        if (aborted(signal) || !(await this.#hasFence(assignment))) {
          return this.#loseLease(binding);
        }
        const thread = await this.#launcher.ensureThread({
          accountProfileId: assignment.accountProfileId,
          runId: assignment.runId,
          title: assignment.title,
          workspacePath: workspace.checkoutPath,
        });
        if (aborted(signal) || !(await this.#hasFence(assignment))) {
          return this.#loseLease(binding);
        }
        if (thread.kind === "ambiguous") {
          return this.#markAmbiguous(binding);
        }
        reconciledThread = thread;
        binding = this.#store.transition({
          runId: binding.runId,
          to: "thread_ready",
          threadId: thread.value.threadId,
        });
      }

      if (binding.stage === "thread_ready") {
        if (aborted(signal) || !(await this.#hasFence(assignment))) {
          return this.#loseLease(binding);
        }
        binding = this.#store.transition({ runId: binding.runId, to: "turn_starting" });
      }

      if (binding.stage === "turn_starting") {
        const thread = reconciledThread ?? await this.#launcher.ensureThread({
            accountProfileId: assignment.accountProfileId,
            runId: assignment.runId,
            title: assignment.title,
            workspacePath: workspace.checkoutPath,
          });
        if (aborted(signal) || !(await this.#hasFence(assignment))) {
          return this.#loseLease(binding);
        }
        if (thread.kind === "ambiguous") return this.#markAmbiguous(binding);
        const turn = await this.#launcher.ensureInitialTurn({
          clientUserMessageId: deterministicMessageId(assignment.runId),
          initialPrompt: assignment.initialPrompt,
          runId: assignment.runId,
          threadId: thread.value.threadId,
        });
        if (turn.kind === "ambiguous") {
          return this.#markAmbiguous(binding);
        }
        if (aborted(signal) || !(await this.#hasFence(assignment))) {
          return this.#loseLease(binding);
        }
        binding = this.#store.transition({
          runId: binding.runId,
          to: "running",
          threadId: thread.value.threadId,
          turnId: turn.value.turnId,
        });
      }

      if (binding.stage === "running") {
        this.#event(binding.runId, 5, "codex.running");
        binding = this.#store.read(binding.runId) ?? binding;
      }
      return { kind: "running", binding };
    } catch (error) {
      const current = this.#store.read(binding.runId) ?? binding;
      if (isTerminal(current.stage) || current.stage === "ambiguous") throw error;
      if (aborted(signal) || !(await this.#hasFence(assignment))) {
        return this.#loseLease(current);
      }
      const failed = this.#store.transition({
        runId: current.runId,
        to: "failed",
        failureCode: classifyFailure(error),
      });
      this.#event(failed.runId, 9, "run.failed");
      return {
        kind: "terminal",
        binding: this.#store.read(failed.runId) ?? failed,
      };
    }
  }

  async #recoverWorkspace(
    assignment: DispatchAssignment,
    binding: DispatchBinding,
  ): Promise<ManagedWorkspace> {
    if (binding.baseSha === null) {
      throw new Error("Dispatch binding is missing its resolved base commit");
    }
    assertManagedWorkspaceIdentity(binding);
    const workspace = await this.#workspaces.provision({
      runId: assignment.runId,
      repositoryPath: assignment.repositoryPath,
      baseSha: binding.baseSha,
    });
    if (binding.laneId !== workspace.laneId) {
      throw new Error("Dispatch binding has a different managed-worktree lane");
    }
    if (binding.branchName !== workspace.branchName) {
      throw new Error("Dispatch binding has a different managed-worktree branch");
    }
    return workspace;
  }

  #event(runId: string, ordinal: number, kind: PublicRunEventKind): { readonly sequence: number } {
    return this.#store.appendPublicEvent({
      runId,
      eventId: `${runId}:${String(ordinal)}`,
      kind,
    });
  }

  async #acknowledge(
    binding: DispatchBinding,
    throughSequence: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (aborted(signal) || !(await this.#hasFence(binding))) return false;
    return await this.#publication.acknowledgeThrough(
      binding.runId,
      throughSequence,
      signal,
    );
  }

  #hasFence(assignment: Pick<
    DispatchReservation,
    "claimFence" | "claimId" | "runId" | "runtimeBootId" | "runtimePublicId"
  >): Promise<boolean> {
    return this.#fence.assertCurrent({
      claimFence: assignment.claimFence,
      claimId: assignment.claimId,
      runId: assignment.runId,
      runtimeBootId: assignment.runtimeBootId,
      runtimePublicId: assignment.runtimePublicId,
    });
  }

  #loseLease(binding: DispatchBinding): DispatchExecutionResult {
    const current = this.#store.read(binding.runId) ?? binding;
    if (current.stage === "lease_lost") return { kind: "lease_lost", binding: current };
    if (isTerminal(current.stage)) return { kind: "terminal", binding: current };
    const lost = this.#store.transition({ runId: current.runId, to: "lease_lost" });
    this.#event(lost.runId, 8, "run.lease_lost");
    return {
      kind: "lease_lost",
      binding: this.#store.read(lost.runId) ?? lost,
    };
  }

  #markAmbiguous(
    binding: DispatchBinding,
    failureCode?: string,
  ): DispatchExecutionResult {
    const current = this.#store.read(binding.runId) ?? binding;
    if (isTerminal(current.stage)) return { kind: "terminal", binding: current };
    const ambiguous = current.stage === "ambiguous"
      ? current
      : this.#store.transition({
          runId: current.runId,
          to: "ambiguous",
          ...(failureCode === undefined ? {} : { failureCode }),
        });
    this.#event(ambiguous.runId, 8, "run.lease_lost");
    return {
      kind: "ambiguous",
      binding: this.#store.read(ambiguous.runId) ?? ambiguous,
    };
  }
}

function assertManagedWorkspaceIdentity(binding: DispatchBinding): void {
  const hasLane = binding.laneId !== null;
  const hasBranch = binding.branchName !== null;
  if (hasLane !== hasBranch) {
    throw new Error("Dispatch binding has incomplete managed-worktree identity");
  }
  if (!hasLane) throw new Error("Dispatch binding is missing managed-worktree identity");
}

function deterministicMessageId(runId: string): string {
  const digest = createHash("sha256").update(`kitchen-dispatch-v1:${runId}`).digest("hex");
  return `message_${digest.slice(0, 48)}`;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function classifyFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_failure";
  const normalized = error.name.replaceAll(/[^A-Za-z0-9_]/gu, "_").toLowerCase();
  return normalized.slice(0, 80) || "runtime_failure";
}

function isTerminal(stage: DispatchStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "cancelled" || stage === "lease_lost";
}

function terminalEventFor(stage: DispatchStage): Readonly<{
  kind: "run.submitted" | "run.failed" | "run.cancelled" | "run.lease_lost";
  ordinal: 6 | 7 | 8 | 9;
}> | null {
  switch (stage) {
    case "completed":
      return { kind: "run.submitted", ordinal: 6 };
    case "cancelled":
      return { kind: "run.cancelled", ordinal: 7 };
    case "lease_lost":
      return { kind: "run.lease_lost", ordinal: 8 };
    case "failed":
      return { kind: "run.failed", ordinal: 9 };
    case "ambiguous":
    case "reserved":
    case "running":
    case "thread_ready":
    case "thread_starting":
    case "turn_starting":
    case "waiting":
    case "worktree_ready":
      return null;
  }
}
