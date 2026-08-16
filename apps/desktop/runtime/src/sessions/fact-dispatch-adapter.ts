import type { GatewaySessionEvent, TimelineItem } from "../internal-contracts";
import type { CodexFact } from "../codex";
import { ownedCodexId } from "./identity";

export interface SessionFactDispatchAdapterOptions {
  readonly admit: (fact: SessionDisplayFact) => boolean;
  readonly emit: (event: GatewaySessionEvent) => void;
}

type SessionDisplayFact = Extract<CodexFact, {
  type: "item.completed" | "item.delta" | "thread.snapshot";
}>;

/** Converts owned facts—not provider notifications—into legacy internal events. */
export class SessionFactDispatchAdapter {
  readonly #admit: SessionFactDispatchAdapterOptions["admit"];
  readonly #emit: SessionFactDispatchAdapterOptions["emit"];
  readonly #revisionsByAccount = new Map<string, number>();

  constructor(options: SessionFactDispatchAdapterOptions) {
    this.#admit = options.admit;
    this.#emit = options.emit;
  }

  consume(fact: CodexFact): boolean {
    if (fact.type === "thread.snapshot") return this.#consumeThreadSnapshot(fact);
    if (fact.type === "item.delta") return this.#consumeDelta(fact);
    if (fact.type === "item.completed") return this.#consumeCompleted(fact);
    return false;
  }

  /** Releases the bounded revision clock after an authorized account removal. */
  purgeAccount(accountProfileId: string): void {
    this.#revisionsByAccount.delete(accountProfileId);
  }

  #consumeThreadSnapshot(
    fact: Extract<CodexFact, { type: "thread.snapshot" }>,
  ): boolean {
    const turn = fact.thread.turns?.at(-1);
    if (!this.#admit(fact) || turn?.items === null || turn === undefined) return false;
    let handled = false;
    for (const item of turn.items.slice(-32)) {
      const timelineItem = this.#timelineItem({
        ...fact,
        type: "item.completed",
        item,
        threadId: fact.thread.id,
        turnId: turn.id,
      });
      if (timelineItem === null) continue;
      this.#emit({ type: "item.upserted", item: timelineItem });
      handled = true;
    }
    return handled;
  }

  #consumeDelta(fact: Extract<CodexFact, { type: "item.delta" }>): boolean {
    if (!this.#admit(fact)) return false;
    this.#emit({
      type: "item.delta",
      itemId: ownedCodexId("item", fact.accountProfileId, fact.itemId),
      threadId: ownedCodexId("thread", fact.accountProfileId, fact.threadId),
      turnId: ownedCodexId("turn", fact.accountProfileId, fact.turnId),
      revision: this.#nextRevision(fact.accountProfileId),
      channel: fact.channel === "assistant_text" ? "text" : "reasoning",
      delta: fact.delta,
    });
    return true;
  }

  #consumeCompleted(
    fact: Extract<CodexFact, { type: "item.completed" }>,
  ): boolean {
    if (!this.#admit(fact)) return false;
    const item = this.#timelineItem(fact);
    if (item === null) return false;
    this.#emit({ type: "item.upserted", item });
    return true;
  }

  #timelineItem(
    fact: Extract<CodexFact, { type: "item.completed" }>,
  ): TimelineItem | null {
    const common = {
      id: ownedCodexId("item", fact.accountProfileId, fact.item.id),
      revision: this.#nextRevision(fact.accountProfileId),
      threadId: ownedCodexId("thread", fact.accountProfileId, fact.threadId),
      turnId: ownedCodexId("turn", fact.accountProfileId, fact.turnId),
    } as const;
    switch (fact.item.kind) {
      case "assistant_text":
        return {
          ...common,
          kind: "message",
          role: "assistant",
          status: "completed",
          text: fact.item.text,
        };
      case "reasoning_summary":
        return {
          ...common,
          kind: "reasoning",
          status: "completed",
          text: fact.item.text,
        };
      case "user_text":
      case "tool":
      case "error":
        // The current gateway contract has no safe generic representation for
        // these owned variants. They remain available through SessionState.
        return null;
    }
  }

  #nextRevision(accountProfileId: string): number {
    const current = this.#revisionsByAccount.get(accountProfileId) ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Session display revision capacity is exhausted.");
    }
    const next = current + 1;
    this.#revisionsByAccount.set(accountProfileId, next);
    return next;
  }
}
