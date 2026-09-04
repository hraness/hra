import type { ClaudeFact } from "../claude/assembler";
import type { CodexFact } from "../codex/protocol";
import type {
  InteractionKind,
  ProviderInteractionAuthority,
} from "../domain/interactions";

/**
 * One Claude fact with the session identity the runtime manager binds to it.
 * The bridge itself knows nothing about HRA sessions, so the manager stamps
 * the provider thread and the exact connection generation onto every fact.
 */
export type ClaudeSessionFact = ClaudeFact & {
  readonly providerThreadId: string;
  readonly connectionId: string;
};

/**
 * The interaction identity a pending Claude control request bound, remembered
 * only until the request is answered or cancelled.
 */
type RememberedInteraction = Readonly<{
  authority: ProviderInteractionAuthority;
  kind: InteractionKind;
}>;

/** Upper bound on remembered pending Claude control requests. */
const REMEMBERED_INTERACTION_LIMIT = 1_024;

/**
 * Translates the Claude bridge's fact vocabulary into the daemon's neutral
 * one.
 *
 * The daemon owns exactly one session timeline, expressed as the fact union
 * `src/codex/protocol.ts` publishes. Rather than teach every reducer, event
 * projector, classifier, and uploader a second vocabulary, the Claude facts
 * are reduced to that same union here: a Claude session then produces the
 * identical transcript events, durable interactions, turn boundaries, and
 * session-state classification as a Codex one, and the cloud projection and
 * live uploader need no provider knowledge at all.
 */
export class ClaudeSessionFactTranslator {
  readonly #authorityFor: (
    providerThreadId: string,
    requestId: string,
  ) => ProviderInteractionAuthority;
  readonly #now: () => number;
  readonly #remembered = new Map<string, RememberedInteraction>();
  /** Item ids already announced on the current turn, per provider thread. */
  readonly #openItems = new Map<string, Map<string, string>>();

  constructor(input: {
    /** The exact provider authority the manager binds to a pending request. */
    authorityFor: (providerThreadId: string, requestId: string) => ProviderInteractionAuthority;
    now: () => number;
  }) {
    this.#authorityFor = input.authorityFor;
    this.#now = input.now;
  }

  /** Empty for a fact the neutral timeline has no place for. */
  translate(fact: ClaudeSessionFact): readonly CodexFact[] {
    const single = this.#translate(fact);
    if (single === null) return [];
    // A text stream is only readable once its item has been announced: the
    // daemon's streaming redactor protects a delta whose item it never saw
    // open. Claude publishes no item lifecycle of its own, so the assembler's
    // item identity is turned into the same `itemStarted`/`itemCompleted`
    // pair Codex emits around its own agent message and reasoning items.
    if (single.type === "assistantDelta" || single.type === "reasoningSummaryDelta") {
      const opened = this.#openItem(
        fact.providerThreadId,
        single.itemId,
        single.type === "assistantDelta" ? "agentMessage" : "reasoning",
      );
      return opened === null ? [single] : [{ ...opened, ...this.#itemFrame(fact, single) }, single];
    }
    if (single.type === "turnCompleted") {
      return [...this.#closeItems(fact, single.turn.id), single];
    }
    if (single.type === "turnStarted") {
      this.#openItems.delete(fact.providerThreadId);
      return [single];
    }
    return [single];
  }

  #itemFrame(
    fact: ClaudeSessionFact,
    delta: Readonly<{ itemId: string; turnId: string }>,
  ): Readonly<{ connectionId: string; itemId: string; threadId: string; turnId: string }> {
    return {
      connectionId: fact.connectionId,
      itemId: delta.itemId,
      threadId: fact.providerThreadId,
      turnId: delta.turnId,
    };
  }

  /** Announces one item once, returning null when it is already open. */
  #openItem(
    providerThreadId: string,
    itemId: string,
    itemKind: string,
  ): Readonly<{ itemKind: string; type: "itemStarted" }> | null {
    let items = this.#openItems.get(providerThreadId);
    if (items === undefined) {
      items = new Map();
      this.#openItems.set(providerThreadId, items);
    }
    if (items.has(itemId)) return null;
    items.set(itemId, itemKind);
    return { itemKind, type: "itemStarted" };
  }

  #closeItems(fact: ClaudeSessionFact, turnId: string): readonly CodexFact[] {
    const items = this.#openItems.get(fact.providerThreadId);
    this.#openItems.delete(fact.providerThreadId);
    if (items === undefined) return [];
    return [...items].map(([itemId, itemKind]) => ({
      connectionId: fact.connectionId,
      itemId,
      itemKind,
      status: "completed",
      threadId: fact.providerThreadId,
      turnId,
      type: "itemCompleted" as const,
    }));
  }

  #translate(fact: ClaudeSessionFact): CodexFact | null {
    const threadId = fact.providerThreadId;
    const connectionId = fact.connectionId;
    switch (fact.type) {
      // The bootstrap line only proves the runtime came up with the reviewed
      // model and permission mode; the reviewed profile is the durable record
      // of that, so nothing is projected.
      case "sessionBootstrapped":
        return null;
      case "turnStarted":
        return {
          connectionId,
          threadId,
          turn: {
            completedAt: null,
            durationMs: null,
            id: fact.turnId,
            items: [],
            startedAt: this.#now(),
            status: "inProgress",
          },
          type: "turnStarted",
        };
      case "turnCompleted":
        return {
          connectionId,
          threadId,
          turn: {
            completedAt: this.#now(),
            durationMs: null,
            id: fact.turnId,
            items: [],
            startedAt: null,
            status: fact.status,
          },
          type: "turnCompleted",
        };
      case "assistantDelta":
        return {
          connectionId,
          itemId: fact.itemId,
          text: fact.text,
          threadId,
          turnId: fact.turnId,
          type: "assistantDelta",
        };
      case "reasoningSummaryDelta":
        return {
          connectionId,
          itemId: fact.itemId,
          summaryIndex: fact.summaryIndex,
          text: fact.text,
          threadId,
          turnId: fact.turnId,
          type: "reasoningSummaryDelta",
        };
      // A started subagent carries its bounded nickname, role, and depth, and
      // only the spawned-thread fact has room for them; a later activity on an
      // already-known agent is the marker-item shape.
      case "subagentActivity":
        return fact.activity === "started"
          ? {
              agentThreadId: fact.taskId,
              connectionId,
              depth: fact.depth,
              nickname: fact.nickname,
              role: fact.role,
              threadId,
              type: "subagentThreadStarted",
            }
          : {
              connectionId,
              itemId: fact.itemId,
              itemKind: "subAgentActivity",
              subagent: { agentThreadId: fact.taskId, kind: fact.activity },
              threadId,
              turnId: fact.turnId,
              ...(fact.status === undefined ? {} : { status: fact.status }),
              type: "itemStarted",
            };
      case "interactionRequested": {
        const authority = this.#authorityFor(threadId, fact.requestId);
        this.#remember(threadId, fact.requestId, { authority, kind: fact.kind });
        return {
          blocking: fact.blocking,
          connectionId,
          display: fact.display,
          kind: fact.kind,
          provider: authority,
          type: "interactionRequested",
        };
      }
      case "interactionCanceled": {
        const remembered = this.#forget(threadId, fact.requestId);
        if (remembered === undefined) return null;
        return {
          connectionId,
          kind: remembered.kind,
          provider: remembered.authority,
          type: "interactionResolved",
        };
      }
      case "tokenUsageUpdated":
        return {
          cachedInputTokens: fact.usage.cachedInputTokens ?? 0,
          connectionId,
          inputTokens: fact.usage.inputTokens ?? 0,
          modelContextWindow: fact.usage.modelContextWindow,
          outputTokens: fact.usage.outputTokens ?? 0,
          reasoningOutputTokens: fact.usage.reasoningOutputTokens ?? 0,
          threadId,
          totalTokens: fact.usage.totalTokens
            ?? (fact.usage.inputTokens ?? 0) + (fact.usage.outputTokens ?? 0),
          turnId: fact.turnId,
          type: "tokenUsageUpdated",
        };
      case "providerError":
        return {
          code: fact.code,
          connectionId,
          message: fact.message,
          terminal: fact.terminal,
          threadId,
          turnId: fact.turnId ?? "",
          type: "providerError",
        };
      case "protocolNotice":
        return { connectionId, method: fact.event, type: "protocolNotice" };
      // The turn summary's exact runtime and result text reach the projection
      // through `readSession`, not the event stream; the rate-limit line names
      // no Codex usage counter HRA could refresh.
      case "turnSummary":
      case "rateLimitObserved":
        return null;
    }
  }

  /** Drops every pending request a closed or replaced session remembered. */
  forgetSession(providerThreadId: string): void {
    const prefix = `${providerThreadId} `;
    for (const key of [...this.#remembered.keys()]) {
      if (key.startsWith(prefix)) this.#remembered.delete(key);
    }
  }

  #remember(providerThreadId: string, requestId: string, value: RememberedInteraction): void {
    if (this.#remembered.size >= REMEMBERED_INTERACTION_LIMIT) {
      const oldest = this.#remembered.keys().next();
      if (!oldest.done) this.#remembered.delete(oldest.value);
    }
    this.#remembered.set(`${providerThreadId} ${requestId}`, value);
  }

  #forget(providerThreadId: string, requestId: string): RememberedInteraction | undefined {
    const key = `${providerThreadId} ${requestId}`;
    const value = this.#remembered.get(key);
    this.#remembered.delete(key);
    return value;
  }
}
