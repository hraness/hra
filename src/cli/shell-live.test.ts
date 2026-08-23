import { describe, expect, test } from "bun:test";

import type { CommandResponse, LocalCommand } from "../domain/contracts";
import type { SessionEvent, SessionEventPage } from "../domain/session-events";
import { ShellLiveObserver } from "./shell-live";

const sessionOne = `sess_${"1".repeat(32)}`;
const sessionTwo = `sess_${"2".repeat(32)}`;
const account = `acct_${"a".repeat(32)}`;
const streamEpoch = "90000000-0000-4000-8000-000000000001";
const privateUserPath = ["", "Users", "person", "private"].join("/");

const ok = (data: unknown): CommandResponse => ({
  data,
  ok: true,
  requestId: crypto.randomUUID(),
  version: 1,
});

const event = (
  sessionId: string,
  sequence: number,
  body: SessionEvent["body"],
): SessionEvent => ({
  version: 1,
  sessionId,
  streamEpoch,
  sequence,
  recordedAt: 1_700_000_000_000 + sequence,
  accountId: account,
  providerGeneration: 1,
  providerConnectionId: null,
  body,
});

const page = (
  sessionId: string,
  requestedCursor: string,
  nextCursor: string,
  events: readonly SessionEvent[],
): SessionEventPage => ({
  version: 1,
  sessionId,
  requestedCursor,
  retentionFloorCursor: "floor",
  observedThroughCursor: nextCursor,
  nextCursor,
  gap: null,
  events: [...events],
});

const status = (
  sessionId: string,
  cursor: string,
  pendingInteractions: readonly unknown[] = [],
): unknown => ({
  version: 1,
  session: { id: sessionId },
  eventStream: { cursor },
  pendingInteractions,
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for shell live observation.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
};

describe("persistent shell live observation", () => {
  test("coalesces safe assistant and reasoning display while withholding raw tool data and paths", async () => {
    let rendered = "";
    let request = 0;
    const requestedCursors: Array<string | undefined> = [];
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        requestedCursors.push(command.cursor);
        if (request === 1) {
          return Promise.resolve(ok(page(sessionOne, "c0", "c1", [
            event(sessionOne, 1, { type: "assistant_delta", turnId: "turn-1", itemId: "assistant-1", text: "done " }),
          ])));
        }
        if (request > 2) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, "c1", "c8", [
          event(sessionOne, 2, { type: "assistant_delta", turnId: "turn-1", itemId: "assistant-1", text: `and verified ${privateUserPath} ` }),
          event(sessionOne, 3, { type: "reasoning_summary_delta", turnId: "turn-1", itemId: "reason-1", text: "Checking " }),
          event(sessionOne, 4, { type: "reasoning_summary_delta", turnId: "turn-1", itemId: "reason-1", text: "the release." }),
          event(sessionOne, 5, {
            type: "tool_progress",
            turnId: "turn-1",
            itemId: "tool-1",
            toolKind: "command",
            server: "/private/raw/server",
            tool: "raw-tool-result-must-not-render",
            status: "completed",
            outputBytesObserved: 99_999,
          }),
          event(sessionOne, 6, {
            type: "file_change",
            turnId: "turn-1",
            itemId: "files-1",
            status: "completed",
            paths: [{ kind: "modified", path: "/private/raw/secret.ts" }],
            omittedPaths: 0,
          }),
          event(sessionOne, 7, { type: "warning", code: "NOTICE", message: "token=abcd1234 at /tmp/private" }),
          event(sessionOne, 8, { type: "turn_completed", turnId: "turn-1", status: "completed" }),
        ])));
      },
      coalesceMs: 5,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/Codex\n/gu)).toHaveLength(1);
    expect(rendered).toContain("done and verified [local-path]");
    expect(rendered.match(/Reasoning summary\n/gu)).toHaveLength(1);
    expect(rendered).toContain("Checking the release.");
    expect(rendered).toContain("Tool: command, completed.");
    expect(rendered).toContain("Files: completed, 1 visible change.");
    expect(rendered).toContain("[protected] at [local-path]");
    expect(rendered).not.toContain(privateUserPath);
    expect(rendered).not.toContain("/private/raw");
    expect(rendered).not.toContain("raw-tool-result-must-not-render");
    expect(rendered).not.toContain("99999");
    expect(rendered).not.toContain("{\"version\"");
    expect(requestedCursors.slice(0, 2)).toEqual(["c0", "c1"]);
  });

  test("shows pending interactions from the status snapshot once without protected answers", async () => {
    let rendered = "";
    const never = new Promise<CommandResponse>(() => undefined);
    const observer = new ShellLiveObserver({
      callDaemon: () => never,
      write: (value) => { rendered += value; },
    });
    const interactionId = "70000000-0000-4000-8000-000000000001";
    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "c0", [{
        id: interactionId,
        kind: "user_input",
        state: "pending",
        revision: 3,
        blocking: true,
        display: {
          summary: "Choose a release channel",
          questions: [{ answer: "protected-answer-must-not-render" }],
        },
        response: { answer: "protected-answer-must-not-render" },
      }]),
    });
    await observer.stop();

    expect(rendered).toContain(`Interaction required: user input ${interactionId}`);
    expect(rendered).toContain("revision 3, blocking");
    expect(rendered).toContain("Choose a release channel");
    expect(rendered).not.toContain("protected-answer-must-not-render");
  });

  test("cancels the old cursor follower before observing a newly selected session", async () => {
    let rendered = "";
    const requests: Array<Readonly<{
      command: Extract<LocalCommand, { kind: "session.events" }>;
      response: Deferred<CommandResponse>;
    }>> = [];
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        const response = deferred<CommandResponse>();
        requests.push({ command, response });
        return response.promise;
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "one-0") });
    await waitUntil(() => requests.length === 1);
    await observer.select({ session: sessionTwo, statusData: status(sessionTwo, "two-0") });
    await waitUntil(() => requests.length === 2);

    requests[0]?.response.resolve(ok(page(sessionOne, "one-0", "one-1", [
      event(sessionOne, 1, { type: "assistant_delta", turnId: "old", itemId: "old", text: "old selection must stay silent" }),
    ])));
    requests[1]?.response.resolve(ok(page(sessionTwo, "two-0", "two-2", [
      event(sessionTwo, 1, { type: "assistant_delta", turnId: "new", itemId: "new", text: "new selection update" }),
      event(sessionTwo, 2, { type: "turn_completed", turnId: "new", status: "completed" }),
    ])));
    await waitUntil(() => rendered.includes("new selection update"));
    await observer.stop();

    expect(rendered).toContain("new selection update");
    expect(rendered).not.toContain("old selection must stay silent");
    expect(requests[0]?.command).toMatchObject({ session: sessionOne, cursor: "one-0" });
    expect(requests[1]?.command).toMatchObject({ session: sessionTwo, cursor: "two-0" });
  });

  test("stops promptly while a daemon long poll remains unresolved", async () => {
    let requested = false;
    const observer = new ShellLiveObserver({
      callDaemon: () => {
        requested = true;
        return new Promise<CommandResponse>(() => undefined);
      },
      write: () => undefined,
    });
    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => requested);

    const stopped = observer.stop().then(() => "stopped" as const);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100));
    expect(await Promise.race([stopped, timeout])).toBe("stopped");
  });
});
