import type { PreparedAttachment } from "../domain/attachments.ts";
import type { ClaudeFact } from "./assembler.ts";
import { ClaudeConnectionEffects } from "./session-effects.ts";
import type { ClaudeInteractionDecision, ClaudeStreamClientOptions, ClaudeStreamInitialization } from "./session-model.ts";
import type { ClaudeProgram } from "./session-platform.ts";
import { ClaudeClientProgram } from "./session-program.ts";

export type { ClaudeInteractionDecision, ClaudeStreamClientOptions, ClaudeStreamInitialization } from "./session-model.ts";

/**
 * Promise boundary for one pinned Claude process. The internal programs compose
 * on a prepared acquisition owner; only this standalone facade interprets them.
 */
export class ClaudeStreamClient {
  readonly #owner: ClaudeConnectionEffects;
  readonly #ownsOwner: boolean;
  #disposal: Promise<void> | undefined;
  readonly programs: ClaudeClientProgram;

  constructor(
    options: ClaudeStreamClientOptions,
    connection?: ClaudeConnectionEffects,
    onFactProgram?: (fact: ClaudeFact) => ClaudeProgram<void>,
  ) {
    this.#ownsOwner = connection === undefined;
    this.#owner = connection ?? new ClaudeConnectionEffects();
    this.programs = new ClaudeClientProgram(options, this.#owner, onFactProgram);
    if (this.#ownsOwner) {
      // Borrowed construction stays inert. A manager composes activate() within
      // its acquisition fiber, so it never re-enters an interpreter here.
      void this.#owner.run("control", this.programs.activate()).catch(() => undefined);
    }
  }

  get configDir(): string { return this.programs.configDir; }
  get providerSessionId(): string | null { return this.programs.providerSessionId; }
  get activeTurnId(): string | null { return this.programs.activeTurnId; }
  get state(): "open" | "closing" | "closed" | "failed" { return this.programs.state; }

  async waitForInitialization(input: Readonly<{ signal: AbortSignal; timeoutMs: number }>): Promise<ClaudeStreamInitialization> {
    return await this.#owner.run("control", this.programs.waitForInitialization(input));
  }

  async startTurn(input: Readonly<{ turnId: string; message: string; attachments?: readonly PreparedAttachment[] }>): Promise<void> {
    await this.#owner.run("control", this.programs.startTurn(input));
  }

  async steer(message: string, attachments: readonly PreparedAttachment[] = []): Promise<void> {
    await this.#owner.run("control", this.programs.steer(message, attachments));
  }

  async interrupt(): Promise<void> { await this.#owner.run("control", this.programs.interrupt()); }

  pendingInteraction(requestId: string): ReturnType<ClaudeClientProgram["pendingInteraction"]> {
    return this.programs.pendingInteraction(requestId);
  }

  validateInteractionResolution(requestId: string, decision: ClaudeInteractionDecision): ReturnType<ClaudeClientProgram["validateInteractionResolution"]> {
    return this.programs.validateInteractionResolution(requestId, decision);
  }

  async resolveInteraction(requestId: string, decision: ClaudeInteractionDecision): Promise<Readonly<{ responseDigest: string }>> {
    return await this.#owner.run("control", this.programs.resolveInteraction(requestId, decision));
  }

  async close(): Promise<void> {
    if (this.#disposal !== undefined) return await this.#disposal;
    await this.#owner.run("control", this.programs.close());
    // Borrowed resources never join or dispose their parent admission, control,
    // capability or continuation groups. The outer manager owns that barrier.
    if (this.#ownsOwner) {
      this.#disposal ??= this.#owner.disposeWhenIdle();
      await this.#disposal;
    }
  }
}
