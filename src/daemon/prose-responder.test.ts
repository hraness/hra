import { describe, expect, test } from "bun:test";

import {
  AI_GATEWAY_CHAT_COMPLETIONS_URL,
  AiGatewayProseResponder,
  DeterministicProseResponder,
  PROSE_APPROVAL_REPLY,
  PROSE_RESPONDER_MODEL,
  ProseResponderError,
  proseResponderSystemPrompt,
  proseResponderUserPrompt,
} from "./prose-responder";
import type { SessionStateReport } from "../domain/session-state";

// Twenty-four printable characters, assembled rather than written, so no
// credential-shaped literal enters the repository.
const testKey = ["gw", "k".repeat(22)].join("");

const report: SessionStateReport = {
  version: 1,
  session: `sess_${"1".repeat(32)}`,
  state: "needs_approval",
  attention: false,
  reason: "should i proceed",
  verbatimRequired: false,
  lastActivityAt: 1_000,
  revision: 2,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

describe("prose responder prompts", () => {
  test("asks for the fixed sentence when no verbatim literal is required", () => {
    const prompt = proseResponderSystemPrompt(undefined);
    expect(prompt).toContain("The human has already reviewed the request and approved it.");
    expect(prompt).toContain(PROSE_APPROVAL_REPLY);
    expect(prompt).toContain("reply text only");
  });

  test("asks for exactly the literal when one is required", () => {
    const prompt = proseResponderSystemPrompt("APPROVE MIGRATION");
    expect(prompt).toContain("Answer with exactly this literal and nothing else: APPROVE MIGRATION");
    expect(prompt).not.toContain(PROSE_APPROVAL_REPLY);
  });

  test("bounds the assistant tail it forwards", () => {
    const prompt = proseResponderUserPrompt({
      assistantTail: "x".repeat(9_000),
      report,
    });
    expect(prompt.length).toBeLessThan(4_400);
    expect(prompt).toContain("Session state: needs_approval.");
  });
});

describe("AiGatewayProseResponder", () => {
  test("posts one bearer-authenticated minimal-effort call and returns the reply", async () => {
    const seen: Array<Readonly<{ body: string; headers: Readonly<Record<string, string>>; url: string }>> = [];
    let clock = 100;
    const responder = new AiGatewayProseResponder({
      fetch: (url, init) => {
        seen.push({ body: init.body, headers: init.headers, url });
        clock = 137;
        return Promise.resolve(jsonResponse({
          choices: [{ message: { content: "  The human has approved. Proceed accordingly.  " } }],
        }));
      },
      now: () => clock,
      readKey: () => Promise.resolve(testKey),
    });

    const result = await responder.respond(
      { assistantTail: "Should I proceed?", report },
      new AbortController().signal,
    );

    expect(result).toEqual({
      latencyMs: 37,
      model: PROSE_RESPONDER_MODEL,
      reply: PROSE_APPROVAL_REPLY,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(AI_GATEWAY_CHAT_COMPLETIONS_URL);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${testKey}`);
    const request = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(request.model).toBe(PROSE_RESPONDER_MODEL);
    expect(request.reasoning_effort).toBe("minimal");
    expect(request.stream).toBe(false);
    // The key never appears in the URL or the request body.
    expect(seen[0]?.url).not.toContain(testKey);
    expect(seen[0]?.body).not.toContain(testKey);
  });

  test("refuses without a configured key and never calls the gateway", async () => {
    let calls = 0;
    const responder = new AiGatewayProseResponder({
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({}));
      },
      readKey: () => Promise.resolve(null),
    });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
    expect(calls).toBe(0);
  });

  test("does not retry a refused call and never leaks the key in the error", async () => {
    let calls = 0;
    const responder = new AiGatewayProseResponder({
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ error: "nope" }, 429));
      },
      readKey: () => Promise.resolve(testKey),
    });
    const failure = await responder
      .respond({ assistantTail: "ask", report }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(ProseResponderError);
    expect((failure as Error).message).toContain("429");
    expect((failure as Error).message).not.toContain(testKey);
  });

  test("refuses a response without usable reply text", async () => {
    const responder = new AiGatewayProseResponder({
      fetch: () => Promise.resolve(jsonResponse({ choices: [] })),
      readKey: () => Promise.resolve(testKey),
    });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
  });

  test("aborts the call when its own deadline passes", async () => {
    const responder = new AiGatewayProseResponder({
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        }, { once: true });
      }),
      readKey: () => Promise.resolve(testKey),
      timeoutMs: 5,
    });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
  });
});

describe("DeterministicProseResponder", () => {
  test("answers with the fixed sentence and echoes a required literal", async () => {
    const responder = new DeterministicProseResponder();
    const signal = new AbortController().signal;
    expect((await responder.respond({ assistantTail: "ask", report }, signal)).reply)
      .toBe(PROSE_APPROVAL_REPLY);
    expect((await responder.respond(
      { assistantTail: "ask", report, verbatimLiteral: "APPROVE MIGRATION" },
      signal,
    )).reply).toBe("APPROVE MIGRATION");
    expect(responder.calls).toHaveLength(2);
  });

  test("rejects when configured to fail", async () => {
    const responder = new DeterministicProseResponder({ failure: "gateway unavailable" });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
  });
});
