import type {
  SessionThreadReconciliation,
  SessionThreadStartRequest,
  SessionThreadStartResult,
  SessionTurnReconciliation,
  SessionTurnStartRequest,
} from "../sessions/session-service";
import type {
  CodexDispatchLauncher,
  ReconciledExternalMutation,
} from "./coordinator";

export interface DispatchSessionPort {
  reconcileThread(input: {
    readonly accountProfileId: string;
    readonly workspacePath: string;
  }): Promise<SessionThreadReconciliation>;
  reconcileInitialTurn(
    threadId: string,
    clientUserMessageId: string,
  ): Promise<SessionTurnReconciliation>;
  startThread(input: SessionThreadStartRequest): Promise<SessionThreadStartResult>;
  startInitialTurn(input: SessionTurnStartRequest): Promise<unknown>;
}

export class SessionDispatchLauncher implements CodexDispatchLauncher {
  readonly #sessions: DispatchSessionPort;

  constructor(sessions: DispatchSessionPort) {
    this.#sessions = sessions;
  }

  async ensureThread(input: {
    readonly accountProfileId: string;
    readonly runId: string;
    readonly title: string;
    readonly workspacePath: string;
  }): Promise<ReconciledExternalMutation<{ readonly threadId: string }>> {
    const observed = await this.#sessions.reconcileThread({
      accountProfileId: input.accountProfileId,
      workspacePath: input.workspacePath,
    });
    if (observed.kind === "ready") {
      return { kind: "ready", value: { threadId: observed.thread.id } };
    }
    if (observed.kind === "ambiguous") return { kind: "ambiguous" };

    try {
      const started = await this.#sessions.startThread({
        accountProfileId: input.accountProfileId,
        title: input.title,
        workspaceMode: "managed",
        workspacePath: input.workspacePath,
      });
      return { kind: "ready", value: { threadId: started.thread.id } };
    } catch (error: unknown) {
      if (!isAmbiguousMutation(error)) throw error;
      const recovered = await this.#sessions.reconcileThread({
        accountProfileId: input.accountProfileId,
        workspacePath: input.workspacePath,
      });
      return recovered.kind === "ready"
        ? { kind: "ready", value: { threadId: recovered.thread.id } }
        : { kind: "ambiguous" };
    }
  }

  async ensureInitialTurn(input: {
    readonly clientUserMessageId: string;
    readonly initialPrompt: string;
    readonly runId: string;
    readonly threadId: string;
  }): Promise<ReconciledExternalMutation<{ readonly turnId: string }>> {
    const observed = await this.#sessions.reconcileInitialTurn(
      input.threadId,
      input.clientUserMessageId,
    );
    if (observed.kind === "ready") {
      return { kind: "ready", value: { turnId: observed.turnId } };
    }
    if (observed.kind !== "missing") return { kind: "ambiguous" };

    try {
      await this.#sessions.startInitialTurn({
        clientUserMessageId: input.clientUserMessageId,
        prompt: input.initialPrompt,
        threadId: input.threadId,
      });
    } catch (error: unknown) {
      if (!isAmbiguousMutation(error)) throw error;
    }
    const recovered = await this.#sessions.reconcileInitialTurn(
      input.threadId,
      input.clientUserMessageId,
    );
    return recovered.kind === "ready"
      ? { kind: "ready", value: { turnId: recovered.turnId } }
      : { kind: "ambiguous" };
  }
}

function isAmbiguousMutation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "upstream_ambiguous";
}
