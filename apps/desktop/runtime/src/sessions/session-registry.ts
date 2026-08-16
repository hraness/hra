import { basename } from "node:path";

import type { AccountSummary } from "../../../contracts/runtime";
import type {
  GatewaySessionEvent,
  ProjectSummary,
  ThreadSummary,
  WorkspaceLaneSummary,
} from "../internal-contracts";
import type {
  CodexThreadSnapshot,
  CodexTurnSnapshot,
  PinnedCodexTurn,
} from "../codex";
import { ownedCodexId } from "./identity";
import { sessionEntityKey, type SessionState } from "./model";
import { createSessionSelectors } from "./selectors";

export interface SessionThreadBinding {
  readonly accountProfileId: AccountSummary["id"];
  readonly codexThreadId: string;
  readonly cwd: string;
  readonly laneMode: WorkspaceLaneSummary["mode"];
  readonly projectId: ProjectSummary["id"];
  readonly title: string;
  readonly updatedAt: string;
  readonly workspaceLaneId: WorkspaceLaneSummary["id"];
}

export interface SessionThreadObservationPreference {
  readonly accountProfileId: AccountSummary["id"];
  readonly laneMode: WorkspaceLaneSummary["mode"];
  readonly preferredProject?: ProjectSummary;
  readonly preferredTitle?: string;
  readonly threadId: string;
}

export interface SessionRegistryTurnLifecycle {
  readonly accountProfileId: AccountSummary["id"];
  readonly quotaProof?: "provider_usage_limit_exceeded";
  readonly status: PinnedCodexTurn["status"];
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface SessionRegistryOptions {
  readonly emit: (event: GatewaySessionEvent) => void;
  readonly errors: Readonly<{
    capacity: (message: string) => Error;
    missingThread: (message: string) => Error;
    protocol: (message: string) => Error;
  }>;
  readonly getSnapshot: () => SessionState;
  readonly onTurnLifecycle: (event: SessionRegistryTurnLifecycle) => void;
}

export interface RemovedSessionThread {
  readonly binding: SessionThreadBinding | null;
  readonly thread: ThreadSummary;
}

export const MAX_SESSION_REGISTRY_PROJECTS = 512;

/**
 * Owns gateway-local project, binding, and legacy thread-summary indexes.
 * SessionStore remains the sole semantic authority for provider state.
 */
export class SessionRegistry {
  readonly #bindingsByCodexId = new Map<string, SessionThreadBinding>();
  readonly #bindingsByOwnedId = new Map<string, SessionThreadBinding>();
  readonly #emit: SessionRegistryOptions["emit"];
  readonly #errors: SessionRegistryOptions["errors"];
  readonly #getSnapshot: SessionRegistryOptions["getSnapshot"];
  readonly #onTurnLifecycle: SessionRegistryOptions["onTurnLifecycle"];
  readonly #projectsById = new Map<string, ProjectSummary>();
  readonly #projectsByPath = new Map<string, ProjectSummary>();
  readonly #rawTurnIdByOwnedId = new Map<string, string>();
  readonly #revisionsByAccount = new Map<string, number>();
  readonly #selectors = createSessionSelectors();
  readonly #threadsByOwnedId = new Map<string, ThreadSummary>();

  constructor(options: SessionRegistryOptions) {
    this.#emit = options.emit;
    this.#errors = options.errors;
    this.#getSnapshot = options.getSnapshot;
    this.#onTurnLifecycle = options.onTurnLifecycle;
  }

  ensureProject(canonicalPath: string, registeredAt: string): ProjectSummary {
    const existing = this.#projectsByPath.get(canonicalPath);
    if (existing !== undefined) return existing;
    this.#pruneUnreferencedProjects(MAX_SESSION_REGISTRY_PROJECTS - 1);
    if (this.#projectsByPath.size >= MAX_SESSION_REGISTRY_PROJECTS) {
      throw this.#errors.capacity(
        "Too many active local folders are retained. Close a session and try again.",
      );
    }
    const project: ProjectSummary = {
      id: stableRegistryId("proj", canonicalPath),
      revision: 1,
      name: boundedRegistryText(basename(canonicalPath), "Local folder", 160),
      displayPath: canonicalPath,
      registeredAt,
    };
    this.#projectsByPath.set(canonicalPath, project);
    this.#projectsById.set(project.id, project);
    this.#emit({ type: "project.upserted", project });
    return project;
  }

  projectById(projectId: ProjectSummary["id"]): ProjectSummary | null {
    return this.#projectsById.get(projectId) ?? null;
  }

  bindingByOwnedId(threadId: ThreadSummary["id"]): SessionThreadBinding | null {
    return this.#bindingsByOwnedId.get(threadId) ?? null;
  }

  bindingByCodexId(
    accountProfileId: AccountSummary["id"],
    codexThreadId: string,
  ): SessionThreadBinding | null {
    return this.#bindingsByCodexId.get(registryBindingKey(
      accountProfileId,
      codexThreadId,
    )) ?? null;
  }

  hasCodexBinding(accountProfileId: string, codexThreadId: string): boolean {
    return this.#bindingsByCodexId.has(registryBindingKey(
      accountProfileId,
      codexThreadId,
    ));
  }

  bindingsForAccount(accountProfileId: string): readonly SessionThreadBinding[] {
    return Object.freeze([...this.#bindingsByOwnedId.values()].filter(
      (binding) => binding.accountProfileId === accountProfileId,
    ));
  }

  threadByOwnedId(threadId: ThreadSummary["id"]): ThreadSummary | null {
    return this.#threadsByOwnedId.get(threadId) ?? null;
  }

  rawTurnIdByOwnedId(ownedTurnId: string): string | null {
    return this.#rawTurnIdByOwnedId.get(ownedTurnId) ?? null;
  }

  requireBinding(threadId: ThreadSummary["id"]): SessionThreadBinding {
    const binding = this.#bindingsByOwnedId.get(threadId);
    if (binding === undefined) {
      throw this.#errors.missingThread(
        "Refresh chats and choose this session again.",
      );
    }
    return binding;
  }

  requireObservedThread(
    accountProfileId: AccountSummary["id"],
    codexThreadId: string,
  ): ThreadSummary {
    const thread = this.#threadsByOwnedId.get(ownedCodexId(
      "thread",
      accountProfileId,
      codexThreadId,
    ));
    if (thread === undefined) {
      throw this.#errors.protocol(
        "Codex session state did not install at its response position.",
      );
    }
    return thread;
  }

  observeThread(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    authoritativeTurns?: boolean;
    codexThreadId: string;
    laneMode?: WorkspaceLaneSummary["mode"];
    preferredProject?: ProjectSummary;
    preferredTitle?: string;
  }>): ThreadSummary {
    const state = this.#getSnapshot();
    const observed = this.#selectors.selectThreadState(
      state,
      input.accountProfileId,
      input.codexThreadId,
    );
    if (observed === null) {
      throw this.#errors.protocol(
        "The accepted Codex thread fact did not produce owned session state.",
      );
    }
    const project = input.preferredProject ?? this.ensureProject(
      observed.cwd,
      observed.createdAt,
    );
    if (project.displayPath !== observed.cwd) {
      throw this.#errors.protocol("Codex returned a different working folder.");
    }
    const laneMode = input.laneMode ?? "local";
    const title = boundedRegistryText(
      observed.title ?? input.preferredTitle,
      input.preferredTitle ?? "New chat",
      240,
    );
    const ownedThreadId = ownedCodexId(
      "thread",
      input.accountProfileId,
      observed.id,
    );
    const workspaceLaneId = stableRegistryId(
      "lane",
      `${input.accountProfileId}\u0000${observed.id}`,
    );
    const lane: WorkspaceLaneSummary = {
      id: workspaceLaneId,
      revision: 1,
      projectId: project.id,
      mode: laneMode,
      status: "ready",
      displayPath: project.displayPath,
      dirty: false,
      preserved: true,
    };
    const binding: SessionThreadBinding = {
      accountProfileId: input.accountProfileId,
      projectId: project.id,
      workspaceLaneId,
      title,
      updatedAt: observed.updatedAt,
      codexThreadId: observed.id,
      cwd: project.displayPath,
      laneMode,
    };
    this.#bindingsByCodexId.set(
      registryBindingKey(input.accountProfileId, observed.id),
      binding,
    );
    this.#bindingsByOwnedId.set(ownedThreadId, binding);
    this.#emit({ type: "workspace.upserted", workspaceLane: lane });

    const current = this.#threadsByOwnedId.get(ownedThreadId);
    const lastTurnState = state.turns[observed.turnKeys.at(-1) ?? ""];
    const lastTurn: CodexTurnSnapshot | undefined = lastTurnState === undefined
      ? undefined
      : {
          completedAt: lastTurnState.completedAt,
          id: lastTurnState.id,
          items: null,
          ...(lastTurnState.quotaProof === undefined
            ? {}
            : { quotaProof: lastTurnState.quotaProof }),
          startedAt: lastTurnState.startedAt,
          status: lastTurnState.status,
        };
    const activeTurn = lastTurn === undefined
      ? input.authoritativeTurns === true
        ? null
        : current?.activeTurn ?? null
      : this.#turnSummary(
          input.accountProfileId,
          lastTurn,
          observed.updatedAt,
        );
    const thread: ThreadSummary = {
      id: ownedThreadId,
      revision: this.#nextRevision(input.accountProfileId),
      accountProfileId: input.accountProfileId,
      projectId: project.id,
      workspaceLaneId,
      title,
      status: registryThreadStatus(observed.status, lastTurn),
      activeTurn,
      attentionCount: 0,
      updatedAt: observed.updatedAt,
    };
    if (lastTurn !== undefined || input.authoritativeTurns === true) {
      this.#replaceActiveTurnRouting(
        current?.activeTurn ?? null,
        activeTurn,
        lastTurn?.status === "active" ? lastTurn.id : null,
      );
    }
    this.#threadsByOwnedId.set(thread.id, thread);
    this.#emit({ type: "thread.upserted", thread });
    if (lastTurn !== undefined) {
      this.#onTurnLifecycle({
        accountProfileId: input.accountProfileId,
        threadId: thread.id,
        turnId: activeTurn?.id ?? ownedCodexId(
          "turn",
          input.accountProfileId,
          lastTurn.id,
        ),
        status: registryProviderTurnStatus(lastTurn.status),
        ...(lastTurn.quotaProof === undefined ? {} : { quotaProof: lastTurn.quotaProof }),
      });
    }
    return thread;
  }

  observeTurn(
    binding: SessionThreadBinding,
    codexTurnId: string,
  ): ThreadSummary {
    const turnState = this.#getSnapshot().turns[sessionEntityKey(
      binding.accountProfileId,
      codexTurnId,
    )];
    if (turnState === undefined) {
      throw this.#errors.protocol(
        "The accepted Codex turn fact did not produce owned session state.",
      );
    }
    const turn: CodexTurnSnapshot = {
      completedAt: turnState.completedAt,
      id: turnState.id,
      items: null,
      ...(turnState.quotaProof === undefined ? {} : { quotaProof: turnState.quotaProof }),
      startedAt: turnState.startedAt,
      status: turnState.status,
    };
    const ownedTurnId = ownedCodexId("turn", binding.accountProfileId, turn.id);
    const current = this.#threadsByOwnedId.get(ownedCodexId(
      "thread",
      binding.accountProfileId,
      binding.codexThreadId,
    ));
    if (current === undefined) {
      throw this.#errors.missingThread(
        "Resume this chat before continuing it.",
      );
    }
    const activeTurn = this.#turnSummary(
      binding.accountProfileId,
      turn,
      binding.updatedAt,
    );
    const thread: ThreadSummary = {
      ...current,
      revision: this.#nextRevision(binding.accountProfileId),
      status: turn.status === "active"
        ? "active"
        : turn.status === "completed"
          ? "idle"
          : turn.status,
      activeTurn,
      updatedAt: activeTurn.completedAt ?? activeTurn.startedAt,
    };
    this.#replaceActiveTurnRouting(
      current.activeTurn,
      activeTurn,
      turn.status === "active" ? turn.id : null,
    );
    this.#threadsByOwnedId.set(thread.id, thread);
    this.#emit({ type: "thread.upserted", thread });
    this.#onTurnLifecycle({
      accountProfileId: binding.accountProfileId,
      threadId: thread.id,
      turnId: ownedTurnId,
      status: registryProviderTurnStatus(turn.status),
      ...(turn.quotaProof === undefined ? {} : { quotaProof: turn.quotaProof }),
    });
    return thread;
  }

  observeTurnTokenUsage(
    binding: SessionThreadBinding,
    codexTurnId: string,
    usage: Readonly<{ inputTokens: number; outputTokens: number }>,
  ): boolean {
    const turn = this.#getSnapshot().turns[sessionEntityKey(
      binding.accountProfileId,
      codexTurnId,
    )];
    const thread = this.#threadsByOwnedId.get(ownedCodexId(
      "thread",
      binding.accountProfileId,
      binding.codexThreadId,
    ));
    if (turn === undefined || thread === undefined) return false;
    this.#onTurnLifecycle({
      accountProfileId: binding.accountProfileId,
      threadId: thread.id,
      turnId: ownedCodexId("turn", binding.accountProfileId, codexTurnId),
      status: registryProviderTurnStatus(turn.status),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(turn.quotaProof === undefined ? {} : { quotaProof: turn.quotaProof }),
    });
    return true;
  }

  refreshThread(accountProfileId: string, codexThreadId: string): boolean {
    const binding = this.bindingByCodexId(accountProfileId, codexThreadId);
    if (binding === null) return false;
    const project = this.projectById(binding.projectId);
    this.observeThread({
      accountProfileId,
      codexThreadId,
      ...(project === null ? {} : { preferredProject: project }),
      laneMode: binding.laneMode,
    });
    return true;
  }

  removeThread(accountProfileId: string, codexThreadId: string): RemovedSessionThread | null {
    const ownedId = ownedCodexId("thread", accountProfileId, codexThreadId);
    const thread = this.#threadsByOwnedId.get(ownedId);
    if (thread === undefined) return null;
    const binding = this.#bindingsByOwnedId.get(ownedId) ?? null;
    this.#threadsByOwnedId.delete(ownedId);
    this.#bindingsByOwnedId.delete(ownedId);
    this.#bindingsByCodexId.delete(registryBindingKey(accountProfileId, codexThreadId));
    if (thread.activeTurn !== null) {
      this.#rawTurnIdByOwnedId.delete(thread.activeTurn.id);
    }
    this.#emit({ type: "thread.removed", threadId: ownedId });
    this.#pruneUnreferencedProjects(MAX_SESSION_REGISTRY_PROJECTS - 1);
    return { binding, thread };
  }

  /** Releases mutable routing state after an authorized account removal. */
  purgeAccount(accountProfileId: string): number {
    const removedIds: string[] = [];
    for (const [ownedId, thread] of this.#threadsByOwnedId) {
      if (thread.accountProfileId !== accountProfileId) continue;
      removedIds.push(ownedId);
      if (thread.activeTurn !== null) {
        this.#rawTurnIdByOwnedId.delete(thread.activeTurn.id);
      }
      this.#threadsByOwnedId.delete(ownedId);
      this.#bindingsByOwnedId.delete(ownedId);
    }
    for (const [key, binding] of this.#bindingsByCodexId) {
      if (binding.accountProfileId === accountProfileId) {
        this.#bindingsByCodexId.delete(key);
      }
    }
    this.#revisionsByAccount.delete(accountProfileId);
    for (const threadId of removedIds) {
      this.#emit({ type: "thread.removed", threadId });
    }
    this.#pruneUnreferencedProjects(MAX_SESSION_REGISTRY_PROJECTS - 1);
    return removedIds.length;
  }

  #turnSummary(
    accountProfileId: AccountSummary["id"],
    turn: CodexTurnSnapshot,
    fallbackTimestamp: string,
  ): NonNullable<ThreadSummary["activeTurn"]> {
    const ownedTurnId = ownedCodexId("turn", accountProfileId, turn.id);
    return {
      id: ownedTurnId,
      revision: this.#nextRevision(accountProfileId),
      status: turn.status,
      startedAt: turn.startedAt ?? fallbackTimestamp,
      completedAt: turn.completedAt,
    };
  }

  #nextRevision(accountProfileId: string): number {
    const current = this.#revisionsByAccount.get(accountProfileId) ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw this.#errors.capacity("Session projection revision capacity is exhausted.");
    }
    const next = current + 1;
    this.#revisionsByAccount.set(accountProfileId, next);
    return next;
  }

  #replaceActiveTurnRouting(
    previous: ThreadSummary["activeTurn"],
    next: ThreadSummary["activeTurn"],
    rawActiveTurnId: string | null,
  ): void {
    if (previous !== null && previous.id !== next?.id) {
      this.#rawTurnIdByOwnedId.delete(previous.id);
    }
    if (rawActiveTurnId === null || next === null || next.status !== "active") {
      if (next !== null) this.#rawTurnIdByOwnedId.delete(next.id);
      return;
    }
    this.#rawTurnIdByOwnedId.set(next.id, rawActiveTurnId);
  }

  #pruneUnreferencedProjects(targetMaximum: number): void {
    if (this.#projectsByPath.size <= targetMaximum) return;
    const referencedProjectIds = new Set(
      [...this.#bindingsByOwnedId.values()].map(({ projectId }) => projectId),
    );
    for (const [canonicalPath, project] of this.#projectsByPath) {
      if (this.#projectsByPath.size <= targetMaximum) return;
      if (referencedProjectIds.has(project.id)) continue;
      this.#projectsByPath.delete(canonicalPath);
      this.#projectsById.delete(project.id);
    }
  }
}

function registryBindingKey(accountProfileId: string, codexId: string): string {
  return `${accountProfileId}\u0000${codexId}`;
}

function registryThreadStatus(
  status: CodexThreadSnapshot["status"],
  latestTurn?: CodexTurnSnapshot,
): ThreadSummary["status"] {
  if (latestTurn?.status === "active" || status === "active") return "active";
  if (latestTurn?.status === "failed" || status === "system_error") return "failed";
  if (latestTurn?.status === "interrupted") return "interrupted";
  return "idle";
}

function registryProviderTurnStatus(
  status: CodexTurnSnapshot["status"],
): PinnedCodexTurn["status"] {
  return status === "active" ? "inProgress" : status;
}

function stableRegistryId(prefix: "lane" | "proj", material: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(material);
  return `${prefix}_${hasher.digest("hex").slice(0, 24)}`;
}

function boundedRegistryText(value: unknown, fallback: string, maximum: number): string {
  const source = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
  let output = "";
  for (const character of source) {
    if (output.length + character.length > maximum) break;
    output += character;
  }
  return output;
}
