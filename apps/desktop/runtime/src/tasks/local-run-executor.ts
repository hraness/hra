import type { DispatchAccountReservationArbiter } from "../dispatch/account-reservations";
import type {
  DispatchCoordinator,
  DispatchExecutionResult,
} from "../dispatch/coordinator";
import type { LocalRunExecutionStore } from "../state/local-run-execution-store";
import type { WorkspaceBroker } from "../workspaces/workspace-broker";
import type { LocalQueuedRunExecutorPort } from "./handler-adapter";
import type { LocalTaskDueWorkHandlerResult } from "./reconciler";

const retryAfterMs = 1_000;

type LocalRunWorkspacePort = Pick<
  WorkspaceBroker,
  "inspectRepository" | "resolveBase"
>;

/**
 * Claims queued local work only after both a process-wide account lane and an
 * immutable Git base are available. Once SQLite admission commits, execution
 * is supervised outside the reconciler so a slow Codex turn cannot block due
 * work or accidentally generic-retry a started intent.
 */
export class LocalQueuedRunExecutor implements LocalQueuedRunExecutorPort {
  readonly #accounts: DispatchAccountReservationArbiter;
  readonly #coordinator: Pick<DispatchCoordinator, "execute">;
  readonly #runtimeBootId: string;
  readonly #runtimePublicId: string;
  readonly #store: LocalRunExecutionStore;
  readonly #workspaces: LocalRunWorkspacePort;
  readonly #onTurnBound: () => void;
  readonly #executions = new Map<string, Promise<void>>();
  readonly #executionControllers = new Map<string, AbortController>();
  #stopping = false;

  constructor(options: {
    readonly accounts: DispatchAccountReservationArbiter;
    readonly coordinator: Pick<DispatchCoordinator, "execute">;
    readonly runtimeBootId: string;
    readonly runtimePublicId: string;
    readonly store: LocalRunExecutionStore;
    readonly workspaces: LocalRunWorkspacePort;
    readonly onTurnBound?: () => void;
  }) {
    this.#accounts = options.accounts;
    this.#coordinator = options.coordinator;
    this.#runtimeBootId = options.runtimeBootId;
    this.#runtimePublicId = options.runtimePublicId;
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#onTurnBound = options.onTurnBound ?? (() => undefined);
  }

  async start(input: Parameters<LocalQueuedRunExecutorPort["start"]>[0]):
    Promise<LocalTaskDueWorkHandlerResult> {
    if (this.#stopping) {
      return { outcome: "obsolete", authority: { kind: "stale", reason: "boot" } };
    }
    const candidate = this.#store.launchCandidate(
      input.work.workspaceId,
      input.work.entityId,
    );
    if (candidate === null) {
      return { outcome: "obsolete", authority: { kind: "stale", reason: "missing" } };
    }
    const account = await this.#accounts.acquire();
    if (account === null) {
      const snapshot = await this.#accounts.snapshot();
      return {
        outcome: "retry",
        authority: input.authority,
        errorCode: snapshot.state,
        retryAfterMs,
      };
    }
    if (this.#stopping) {
      this.#accounts.release(account);
      return { outcome: "obsolete", authority: { kind: "stale", reason: "boot" } };
    }
    let baseSha: string;
    try {
      const inspected = await this.#workspaces.inspectRepository(
        candidate.repositoryPath,
      );
      if (
        inspected.canonicalRepositoryPath !== candidate.repositoryPath
        || inspected.canonicalGitCommonDir !== candidate.canonicalGitCommonDir
      ) {
        throw new Error("Registered repository identity changed");
      }
      baseSha = await this.#workspaces.resolveBase(
        inspected.canonicalRepositoryPath,
        candidate.baseRef,
      );
    } catch {
      this.#accounts.release(account);
      return {
        outcome: "retry",
        authority: input.authority,
        errorCode: "repository_unavailable",
        retryAfterMs,
      };
    }
    if (this.#stopping) {
      this.#accounts.release(account);
      return { outcome: "obsolete", authority: { kind: "stale", reason: "boot" } };
    }

    this.#accounts.bind(account, candidate.runId);
    let admitted;
    try {
      admitted = this.#store.admit({
        accountProfileId: account.accountProfileId,
        authority: input.authority,
        baseSha,
        bootGeneration: input.context.bootGeneration,
        now: input.context.wallNow,
        runtimeBootId: this.#runtimeBootId,
        runtimePublicId: this.#runtimePublicId,
        work: input.work,
      });
    } catch (error: unknown) {
      this.#accounts.releaseRun(candidate.runId);
      throw error;
    }
    if (admitted.kind === "obsolete") {
      this.#accounts.releaseRun(candidate.runId);
      return { outcome: "obsolete", authority: admitted.authority };
    }
    const controller = new AbortController();
    this.#executionControllers.set(candidate.runId, controller);
    const task = this.#execute(
      admitted.admission.assignment,
      controller.signal,
    )
      .finally(() => {
        if (this.#executions.get(candidate.runId) === task) {
          this.#executions.delete(candidate.runId);
        }
        if (this.#executionControllers.get(candidate.runId) === controller) {
          this.#executionControllers.delete(candidate.runId);
        }
      });
    this.#executions.set(candidate.runId, task);
    void task.catch(() => undefined);
    return { outcome: "settled", authority: input.authority };
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#executions.values()]);
  }

  hasUnsettledWork(): boolean {
    return this.#executions.size > 0;
  }

  closeAdmission(): void {
    this.#stopping = true;
  }

  async stop(): Promise<void> {
    this.closeAdmission();
    for (const controller of this.#executionControllers.values()) {
      controller.abort();
    }
    await this.settled();
  }

  async #execute(
    assignment: Parameters<DispatchCoordinator["execute"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    let result: DispatchExecutionResult;
    try {
      result = await this.#coordinator.execute(assignment, signal);
    } catch {
      const binding = this.#store.read(assignment.runId);
      let release = binding !== null && (
        binding.stage === "completed"
        || binding.stage === "failed"
        || binding.stage === "cancelled"
        || binding.stage === "lease_lost"
      );
      if (
        binding !== null
        && binding.stage !== "completed"
        && binding.stage !== "failed"
        && binding.stage !== "cancelled"
        && binding.stage !== "lease_lost"
        && binding.stage !== "ambiguous"
      ) {
        this.#store.transition({
          runId: assignment.runId,
          to: "lease_lost",
          failureCode: "local_execution_unhandled",
        });
        this.#store.appendPublicEvent({
          runId: assignment.runId,
          eventId: `${assignment.runId}:local_execution_unhandled`,
          kind: "run.lease_lost",
        });
        release = true;
      }
      if (release) {
        if (this.#store.releaseCapacity(assignment.runId)) {
          this.#accounts.releaseRun(assignment.runId);
        }
      }
      return;
    }
    if (result.kind === "running") {
      // SessionService may synchronously emit a terminal callback before the
      // coordinator can persist turnId. Retry immediately at the binding edge.
      this.#onTurnBound();
    }
    if (result.kind === "terminal" || result.kind === "lease_lost") {
      if (this.#store.releaseCapacity(assignment.runId)) {
        this.#accounts.releaseRun(assignment.runId);
      }
    }
  }
}
