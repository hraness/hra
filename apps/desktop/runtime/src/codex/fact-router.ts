import type { CodexFact } from "./facts";
import { projectCodexNotificationFacts } from "./fact-projector";
import type { CodexNotification } from "./pinned-protocol";

type Awaitable<T> = T | Promise<T>;

export interface CodexFactConsumer {
  consumeCodexFacts(facts: readonly CodexFact[]): Awaitable<void>;
}

export interface CodexFactRouterOptions {
  readonly account: () => CodexFactConsumer | null;
  readonly session: () => CodexFactConsumer | null;
  readonly harness?: () => CodexFactConsumer | null;
}

export class CodexFactConsumerError extends Error {
  constructor() {
    super("An owned Codex fact consumer failed; the process generation must restart.");
    this.name = "CodexFactConsumerError";
  }
}

/** One projection and explicit fan-out; no consumer is a fallback for another. */
export class CodexFactRouter {
  readonly #account: CodexFactRouterOptions["account"];
  readonly #session: CodexFactRouterOptions["session"];
  readonly #harness: () => CodexFactConsumer | null;

  constructor(options: CodexFactRouterOptions) {
    this.#account = options.account;
    this.#session = options.session;
    this.#harness = options.harness ?? (() => null);
  }

  async routeNotification(
    accountProfileId: string,
    notification: CodexNotification,
  ): Promise<readonly CodexFact[]> {
    const facts = projectCodexNotificationFacts(accountProfileId, notification);
    let failed = false;
    for (const consumer of [this.#account(), this.#session(), this.#harness()]) {
      if (consumer === null) continue;
      try {
        await consumer.consumeCodexFacts(facts);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new CodexFactConsumerError();
    return facts;
  }
}
