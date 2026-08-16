import {
  createRunInteractionRequestDigest,
  runInteractionRequestSchema,
  taskDomain,
  type PortableTaskCommand,
  type RunInteractionReplyKeyPair,
  type RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";

import type {
  SessionInteractionExpired,
  SessionInteractionRequest,
  SessionService,
} from "../sessions/session-service";
import type {
  LocalRunExecutionStore,
  LocalRunTaskChange,
} from "../state/local-run-execution-store";
import type { LocalTaskStore } from "../state/local-task-store";

type InteractionResponseCommand = Extract<
  PortableTaskCommand,
  { readonly kind: "interaction.respond" }
>;

/**
 * Keeps provider response closures in SessionService while persisting only the
 * bounded public request and its local state. Plaintext answers flow directly
 * from the already-committed command into the provider and are never stored.
 */
export class LocalRunInteractionAdapter {
  readonly #identity: Readonly<{
    bootGeneration: number;
    bootId: string;
    runnerId: string;
  }>;
  readonly #onAmbiguous: (runId: string) => void | Promise<void>;
  readonly #onCommitted: (input: LocalRunTaskChange) => void;
  readonly #replyKey: RunInteractionReplyKeyPair;
  readonly #sessions: Pick<SessionService, "resolveInteraction">;
  readonly #store: LocalRunExecutionStore;
  readonly #tasks: LocalTaskStore;

  constructor(options: {
    readonly identity: Readonly<{
      bootGeneration: number;
      bootId: string;
      runnerId: string;
    }>;
    readonly onAmbiguous: (runId: string) => void | Promise<void>;
    readonly onCommitted: (input: LocalRunTaskChange) => void;
    readonly replyKey: RunInteractionReplyKeyPair;
    readonly sessions: Pick<SessionService, "resolveInteraction">;
    readonly store: LocalRunExecutionStore;
    readonly tasks: LocalTaskStore;
  }) {
    this.#identity = options.identity;
    this.#onAmbiguous = options.onAmbiguous;
    this.#onCommitted = options.onCommitted;
    this.#replyKey = options.replyKey;
    this.#sessions = options.sessions;
    this.#store = options.store;
    this.#tasks = options.tasks;
  }

  async observeRequest(
    event: SessionInteractionRequest,
  ): Promise<RunInteractionRequest | null> {
    let binding = this.#store.readByTurn(event);
    if (
      binding === null
      || (binding.stage !== "running" && binding.stage !== "waiting")
      || !(await this.#current(binding))
    ) return null;
    binding = this.#store.readByTurn(event);
    if (binding === null || binding.stage !== "waiting") return null;
    const persisted = this.#store.requestInteraction({
      accountProfileId: event.accountProfileId,
      request: event.request,
      threadId: event.threadId,
      turnId: event.turnId,
    });
    if (persisted === null) return null;
    return runInteractionRequestSchema.parse({
      ...event.request,
      reply: {
        version: 1,
        algorithm: "P256-HKDF-SHA256-A256GCM",
        keyId: this.#replyKey.keyId,
        publicKey: this.#replyKey.publicKey,
        runnerId: this.#identity.runnerId,
        bootId: this.#identity.bootId,
        bootGeneration: this.#identity.bootGeneration,
        claimId: binding.claimId,
        claimFence: binding.claimFence,
        requestDigest: await createRunInteractionRequestDigest(event.request),
      },
    });
  }

  observeExpired(event: SessionInteractionExpired): void {
    const before = this.#store.interactionAuthority(event.interactionId);
    if (before === null) return;
    if (before.state === "pending") {
      this.#store.expireInteraction(event.interactionId);
      return;
    }
    if (before.state === "answered") {
      void Promise.resolve(this.#onAmbiguous(before.runId)).catch(() => undefined);
    }
  }

  async respond(command: InteractionResponseCommand): Promise<void> {
    const authority = this.#store.interactionAuthority(command.interactionId);
    if (
      authority === null
      || authority.runId !== command.runId
      || authority.state !== "answered"
      || authority.responseRevision === null
    ) {
      await this.#onAmbiguous(command.runId);
      return;
    }
    const binding = this.#store.read(command.runId);
    if (binding === null || binding.stage !== "waiting") {
      await this.#onAmbiguous(command.runId);
      return;
    }
    let resolution: Awaited<
      ReturnType<Pick<SessionService, "resolveInteraction">["resolveInteraction"]>
    >;
    try {
      resolution = await this.#sessions.resolveInteraction(
        command.interactionId,
        command.response,
        async () => await this.#currentWaiting(binding),
      );
    } catch {
      await this.#onAmbiguous(command.runId);
      return;
    }
    if (resolution.kind !== "applied") {
      await this.#onAmbiguous(command.runId);
      return;
    }
    const settlement = {
      kind: "interaction.settle",
      operationId: publicId(
        "op",
        `local-interaction-settle:${command.interactionId}:${String(authority.responseRevision)}`,
      ),
      authority: {
        kind: "local_owner",
        workspaceId: authority.workspaceId,
        installationId: authority.installationId,
      },
      expectedWorkspaceRevision: authority.expectedWorkspaceRevision,
      taskId: authority.taskId,
      expectedTaskRevision: authority.expectedTaskRevision,
      runId: authority.runId,
      settlement: {
        interactionId: command.interactionId,
        responseRevision: authority.responseRevision,
        outcome: "applied",
      },
    } as const;
    const disposition = this.#tasks.executeWithDisposition(
      settlement,
      { kind: "agent", agentId: authority.agentId },
    );
    if (disposition.receipt.outcome !== "committed") {
      await this.#onAmbiguous(command.runId);
      return;
    }
    if (!disposition.replayed) {
      this.#onCommitted(taskDomain.portableTaskChangeRecordSchema.parse({
        workspaceId: disposition.receipt.workspaceId,
        projectionRevision: disposition.receipt.workspaceRevision,
        scope: "task_change",
        taskId: authority.taskId,
        runId: authority.runId,
        changeKind: "run.interaction_changed",
        affectedProjections: [{
          projection: "task_list",
          views: [...taskDomain.taskWorkspaceViewValues],
        }, {
          projection: "task_detail",
        }],
      }));
    }
    const current = this.#store.read(command.runId);
    if (current?.stage !== "waiting") {
      await this.#onAmbiguous(command.runId);
      return;
    }
    try {
      this.#store.transition({ runId: command.runId, to: "running" });
      this.#store.appendPublicEvent({
        runId: command.runId,
        eventId: `${command.runId}:interaction:${command.interactionId}:resolved`,
        kind: "codex.running",
      });
    } catch {
      await this.#onAmbiguous(command.runId);
    }
  }

  #current(binding: NonNullable<ReturnType<LocalRunExecutionStore["read"]>>):
    Promise<boolean> {
    return this.#store.assertCurrent({
      claimFence: binding.claimFence,
      claimId: binding.claimId,
      runId: binding.runId,
      runtimeBootId: binding.runtimeBootId,
      runtimePublicId: binding.runtimePublicId,
    });
  }

  async #currentWaiting(
    expected: NonNullable<ReturnType<LocalRunExecutionStore["read"]>>,
  ): Promise<boolean> {
    const current = this.#store.read(expected.runId);
    return current !== null
      && current.stage === "waiting"
      && current.claimId === expected.claimId
      && current.claimFence === expected.claimFence
      && await this.#current(current);
  }
}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function publicId(prefix: string, seed: string): string {
  let value = BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`);
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[Number(value & 31n)] ?? "0") + locator;
    value >>= 5n;
  }
  return `${prefix}_${locator}`;
}
