import { AccountServiceError } from "../accounts/account-service";
import { SessionServiceError } from "../sessions/session-service";
import type { SessionService } from "../sessions/session-service";
import type {
  CHAT_MODEL,
  ChatHistoryItem,
  ChatProviderPort,
  ChatProviderResumeRequest,
  ChatProviderThreadRequest,
  ChatProviderTurnRequest,
  ChatReasoningEffort,
  ChatServiceTier,
  ChatThreadBinding,
} from "./types";
import { ChatProviderEffectError } from "./types";

type ChatSessionRuntime = Pick<
  SessionService,
  | "injectChatHistory"
  | "interruptChatTurn"
  | "resumeChatThread"
  | "setChatThreadName"
  | "startChatThread"
  | "startChatTurn"
  | "validateChatConfiguration"
>;

/** Session-aware Codex 0.144.6 implementation of the provider-neutral chat port. */
export class CodexChatProvider implements ChatProviderPort {
  readonly #sessions: ChatSessionRuntime;
  readonly #validatedConfigurations = new Set<string>();

  constructor(sessions: ChatSessionRuntime) {
    this.#sessions = sessions;
  }

  async validateConfiguration(
    accountProfileId: string,
    model: typeof CHAT_MODEL,
    reasoningEffort: ChatReasoningEffort,
    serviceTier: ChatServiceTier = "standard",
  ): Promise<void> {
    const cacheKey = `${accountProfileId}\0${model}\0${reasoningEffort}\0${serviceTier}`;
    const cacheable = serviceTier === "standard";
    if (cacheable && this.#validatedConfigurations.has(cacheKey)) return;
    try {
      await this.#sessions.validateChatConfiguration(
        accountProfileId,
        model,
        reasoningEffort,
        serviceTier,
      );
      if (cacheable) this.#validatedConfigurations.add(cacheKey);
    } catch (error: unknown) {
      throw providerFailure(error, false, "configuration");
    }
  }

  async startThread(request: ChatProviderThreadRequest): Promise<Readonly<{
    threadId: string;
    restartThreadId: string;
  }>> {
    try {
      const started = await this.#sessions.startChatThread({
        accountProfileId: request.accountProfileId,
        serviceTier: request.serviceTier ?? "standard",
        title: request.title,
        workspacePath: request.workingDirectory,
      });
      return {
        threadId: started.thread.id,
        restartThreadId: started.restartThreadId,
      };
    } catch (error: unknown) {
      throw preserveOrMap(error, true);
    }
  }

  async resumeThread(request: ChatProviderResumeRequest): Promise<void> {
    try {
      await this.#sessions.resumeChatThread({
        accountProfileId: request.accountProfileId,
        threadId: request.threadId,
        restartThreadId: request.restartThreadId,
        serviceTier: request.serviceTier ?? "standard",
        title: request.title,
        workspacePath: request.workingDirectory,
      });
    } catch (error: unknown) {
      throw preserveOrMap(error, true);
    }
  }

  async setThreadName(binding: ChatThreadBinding, name: string): Promise<void> {
    try {
      await this.#sessions.setChatThreadName(binding.threadId, name);
    } catch (error: unknown) {
      throw preserveOrMap(error, true);
    }
  }

  async injectHistory(
    binding: ChatThreadBinding,
    history: readonly ChatHistoryItem[],
  ): Promise<void> {
    if (history.length === 0) return;
    try {
      await this.#sessions.injectChatHistory(binding.threadId, history);
    } catch (error: unknown) {
      throw preserveOrMap(error, true);
    }
  }

  async startTurn(request: ChatProviderTurnRequest): Promise<Readonly<{
    turnId: string;
    quotaProofCursor: Readonly<{ generation: number; streamPosition: number }>;
  }>> {
    try {
      const started = await this.#sessions.startChatTurn({
        clientUserMessageId: ownedClientMessageId(request.clientTurnId),
        prompt: request.prompt,
        reasoningEffort: request.reasoningEffort,
        serviceTier: request.serviceTier ?? "standard",
        threadId: request.threadId,
      });
      return {
        turnId: started.turnId,
        quotaProofCursor: {
          generation: started.generation,
          streamPosition: started.streamPosition,
        },
      };
    } catch (error: unknown) {
      throw preserveOrMap(error, true);
    }
  }

  async interruptTurn(input: ChatThreadBinding & Readonly<{ readonly turnId: string }>): Promise<void> {
    try {
      await this.#sessions.interruptChatTurn(input.threadId, input.turnId);
    } catch (error: unknown) {
      throw preserveOrMap(error, true);
    }
  }
}

function ownedClientMessageId(turnId: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`oprte-chat-message-v1\0${turnId}`);
  return `message_${hasher.digest("hex").slice(0, 48)}`;
}

function preserveOrMap(error: unknown, mutation: boolean): ChatProviderEffectError {
  return error instanceof ChatProviderEffectError
    ? error
    : providerFailure(error, mutation, "unknown");
}

function providerFailure(
  error: unknown,
  mutation: boolean,
  fallback: "configuration" | "unknown",
): ChatProviderEffectError {
  if (error instanceof AccountServiceError) {
    if (error.code === "upstream_ambiguous") {
      return new ChatProviderEffectError({ certainty: "ambiguous", code: "runtime" });
    }
    if (
      error.code === "runtime_unavailable" && error.retryable &&
      error.action === "retry"
    ) {
      // Runtime-capacity admission fails before a process or provider request
      // exists. Preserve that proof instead of escalating a safe retry into
      // an ambiguous provider mutation and account-generation fence.
      return new ChatProviderEffectError({ certainty: "not_applied", code: "runtime" });
    }
  }
  if (error instanceof SessionServiceError) {
    if (error.code === "upstream_ambiguous") {
      return new ChatProviderEffectError({ certainty: "ambiguous", code: "runtime" });
    }
    if (error.code === "capability_unavailable" || error.code === "not_found") {
      return new ChatProviderEffectError({
        certainty: "not_applied",
        code: fallback === "configuration" ? "configuration" : "authentication",
      });
    }
  }
  return new ChatProviderEffectError({
    certainty: mutation ? "ambiguous" : "not_applied",
    code: fallback,
  });
}
