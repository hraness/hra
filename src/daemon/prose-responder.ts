/*
 * Prose-approval responder port.
 *
 * When an assistant turn ends by asking only for consent, the daemon has
 * already decided (positive gate, budgets, cues) that a reply may be sent on
 * the human's behalf. The responder produces the reply text and the evidence
 * fields — model and latency — for that attempt. It is a narrow port: one
 * bounded call, one bounded string back, no tools, no streaming, no retries.
 *
 * Two implementations ship: a Vercel AI Gateway call over the OpenAI-compatible
 * chat-completions endpoint, and a deterministic fake used by tests.
 *
 * The responder is never trusted. The daemon decides what is actually sent: a
 * verbatim ask must come back as a byte-exact substring of the assistant's own
 * message, and every other approval is answered with one fixed sentence. The
 * gateway key is passed in a request header only; it is never logged, never
 * put in a URL, and never included in an error message.
 */

import type { SessionStateReport } from "../domain/session-state";

/** The only free-text reply the daemon ever sends for a non-verbatim approval. */
export const PROSE_APPROVAL_REPLY = "The human has approved. Proceed accordingly.";

/** OpenAI-compatible chat-completions endpoint of the Vercel AI Gateway. */
export const AI_GATEWAY_CHAT_COMPLETIONS_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Gateway model identifier used for prose autorespond. */
export const PROSE_RESPONDER_MODEL = "openai/gpt-5-nano";

/** One call, ten seconds, no retries. */
export const PROSE_RESPONDER_TIMEOUT_MS = 10_000;

/** Upper bound on the assistant tail handed to the responder. */
export const PROSE_RESPONDER_TAIL_MAX_CHARACTERS = 4_000;

/** Upper bound on an accepted reply, in characters. */
export const PROSE_RESPONDER_REPLY_MAX_CHARACTERS = 2_000;

/** Upper bound on the gateway response body, in bytes. */
export const PROSE_RESPONDER_RESPONSE_MAX_BYTES = 64 * 1024;

export type ProseResponderInput = Readonly<{
  assistantTail: string;
  report: SessionStateReport;
  verbatimLiteral?: string;
}>;

export type ProseResponderResult = Readonly<{
  latencyMs: number;
  model: string;
  reply: string;
}>;

export interface ProseResponder {
  respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult>;
}

export class ProseResponderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProseResponderError";
  }
}

/*
 * The system prompt states the decision that has already been made and asks
 * for reply text only. It forbids commentary so the daemon's verbatim check
 * has a chance of passing, and it never carries the session identifier, a
 * path, or any credential.
 */
export function proseResponderSystemPrompt(verbatimLiteral: string | undefined): string {
  const common = [
    "You write the human operator's reply to a coding agent that has paused to ask for approval.",
    "The human has already reviewed the request and approved it.",
    "Answer with the reply text only: no greeting, no quotation marks, no explanation, no code fences.",
  ];
  return verbatimLiteral === undefined
    ? [
        ...common,
        `Reply with exactly this sentence: ${PROSE_APPROVAL_REPLY}`,
      ].join("\n")
    : [
        ...common,
        "The agent asked for one exact string to be pasted back.",
        `Answer with exactly this literal and nothing else: ${verbatimLiteral}`,
      ].join("\n");
}

export function proseResponderUserPrompt(input: ProseResponderInput): string {
  const tail = input.assistantTail.length > PROSE_RESPONDER_TAIL_MAX_CHARACTERS
    ? input.assistantTail.slice(-PROSE_RESPONDER_TAIL_MAX_CHARACTERS)
    : input.assistantTail;
  return [
    `Session state: ${input.report.state ?? "unknown"}.`,
    `Approval cue: ${input.report.reason}.`,
    "The agent's closing message follows.",
    "---",
    tail,
  ].join("\n");
}

type GatewayFetch = (
  url: string,
  init: Readonly<{
    body: string;
    headers: Readonly<Record<string, string>>;
    method: "POST";
    signal: AbortSignal;
  }>,
) => Promise<Response>;

const boundedReply = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ProseResponderError("The gateway response did not contain reply text.");
  }
  const reply = value.trim();
  if (reply.length === 0 || reply.length > PROSE_RESPONDER_REPLY_MAX_CHARACTERS) {
    throw new ProseResponderError("The gateway reply is empty or beyond the accepted bound.");
  }
  return reply;
};

const replyFromGatewayBody = (decoded: unknown): string => {
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ProseResponderError("The gateway response is not an object.");
  }
  const choices = (decoded as Readonly<Record<string, unknown>>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProseResponderError("The gateway response carried no choice.");
  }
  const first = choices[0] as unknown;
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    throw new ProseResponderError("The gateway response carried an invalid choice.");
  }
  const message = (first as Readonly<Record<string, unknown>>).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProseResponderError("The gateway response carried an invalid message.");
  }
  return boundedReply((message as Readonly<Record<string, unknown>>).content);
};

/*
 * Vercel AI Gateway responder. One POST, a ten-second deadline, no retries: a
 * failed or slow call escalates the turn to the human instead of being tried
 * again on the human's behalf.
 */
export class AiGatewayProseResponder implements ProseResponder {
  readonly #fetch: GatewayFetch;
  readonly #model: string;
  readonly #now: () => number;
  readonly #readKey: () => Promise<string | null>;
  readonly #timeoutMs: number;
  readonly #url: string;

  constructor(input: Readonly<{
    readKey: () => Promise<string | null>;
    fetch?: GatewayFetch;
    model?: string;
    now?: () => number;
    timeoutMs?: number;
    url?: string;
  }>) {
    this.#readKey = input.readKey;
    this.#fetch = input.fetch ?? ((url, init) => fetch(url, init));
    this.#model = input.model ?? PROSE_RESPONDER_MODEL;
    this.#now = input.now ?? Date.now;
    this.#timeoutMs = input.timeoutMs ?? PROSE_RESPONDER_TIMEOUT_MS;
    this.#url = input.url ?? AI_GATEWAY_CHAT_COMPLETIONS_URL;
  }

  async respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult> {
    const key = await this.#readKey();
    if (key === null) throw new ProseResponderError("No gateway key is configured.");
    const startedAt = this.#now();
    const deadline = new AbortController();
    const abort = (): void => deadline.abort(new Error("Prose responder aborted."));
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => deadline.abort(new Error("Prose responder timed out.")),
      this.#timeoutMs,
    );
    try {
      const response = await this.#fetch(this.#url, {
        body: JSON.stringify({
          messages: [
            { content: proseResponderSystemPrompt(input.verbatimLiteral), role: "system" },
            { content: proseResponderUserPrompt(input), role: "user" },
          ],
          model: this.#model,
          reasoning_effort: "minimal",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: deadline.signal,
      });
      if (!response.ok) {
        throw new ProseResponderError(
          `The gateway refused the responder call with status ${String(response.status)}.`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > PROSE_RESPONDER_RESPONSE_MAX_BYTES) {
        throw new ProseResponderError("The gateway response exceeded the accepted bound.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new ProseResponderError("The gateway response is not one UTF-8 JSON document.");
      }
      return {
        latencyMs: Math.max(0, this.#now() - startedAt),
        model: this.#model,
        reply: replyFromGatewayBody(decoded),
      };
    } catch (error: unknown) {
      if (error instanceof ProseResponderError) throw error;
      throw new ProseResponderError("The gateway responder call did not complete.");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

/*
 * Deterministic responder for tests and offline runs: it answers with the
 * verbatim literal when one is required and with the fixed approval sentence
 * otherwise. A caller may override the reply or force a failure to exercise
 * the daemon's mismatch and failure paths.
 */
export class DeterministicProseResponder implements ProseResponder {
  readonly calls: ProseResponderInput[] = [];
  readonly #failure: string | null;
  readonly #latencyMs: number;
  readonly #model: string;
  readonly #reply: ((input: ProseResponderInput) => string) | null;

  constructor(options: Readonly<{
    failure?: string;
    latencyMs?: number;
    model?: string;
    reply?: (input: ProseResponderInput) => string;
  }> = {}) {
    this.#failure = options.failure ?? null;
    this.#latencyMs = options.latencyMs ?? 7;
    this.#model = options.model ?? PROSE_RESPONDER_MODEL;
    this.#reply = options.reply ?? null;
  }

  respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult> {
    this.calls.push(input);
    if (signal.aborted) {
      return Promise.reject(new ProseResponderError("The responder call was aborted."));
    }
    if (this.#failure !== null) {
      return Promise.reject(new ProseResponderError(this.#failure));
    }
    const reply = this.#reply === null
      ? input.verbatimLiteral ?? PROSE_APPROVAL_REPLY
      : this.#reply(input);
    return Promise.resolve({
      latencyMs: this.#latencyMs,
      model: this.#model,
      reply,
    });
  }
}
