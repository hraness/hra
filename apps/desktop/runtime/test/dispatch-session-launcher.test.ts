import { describe, expect, test } from "bun:test";

import {
  SessionDispatchLauncher,
  type DispatchSessionPort,
} from "../src/dispatch/session-launcher";

const thread = {
  id: "thread_primary0001",
  revision: 1,
  accountProfileId: "acct_primary0001",
  projectId: "proj_primary000001",
  workspaceLaneId: "lane_primary000001",
  title: "Task",
  status: "idle" as const,
  activeTurn: null,
  attentionCount: 0,
  updatedAt: "2026-07-20T12:00:00.000Z",
};

function port(overrides: Partial<DispatchSessionPort> = {}): DispatchSessionPort {
  return {
    reconcileThread: () => Promise.resolve({ kind: "missing" }),
    reconcileInitialTurn: () => Promise.resolve({
      kind: "missing",
      generation: 1,
      responsePosition: 1,
    }),
    startThread: () => Promise.resolve({
      project: {
        id: "proj_primary000001",
        revision: 1,
        name: "lane",
        displayPath: "/private/lane",
        registeredAt: "2026-07-20T12:00:00.000Z",
      },
      thread,
    }),
    startInitialTurn: () => Promise.resolve(thread),
    ...overrides,
  };
}

describe("dispatch session launch reconciliation", () => {
  test("reuses the one thread already bound to the managed worktree", async () => {
    let starts = 0;
    const launcher = new SessionDispatchLauncher(port({
      reconcileThread: () => Promise.resolve({ kind: "ready", thread }),
      startThread: () => {
        starts += 1;
        return Promise.reject(new Error("must not start another thread"));
      },
    }));

    expect(await launcher.ensureThread({
      accountProfileId: "acct_primary0001",
      runId: "run_primary0001",
      title: "Task",
      workspacePath: "/private/lane",
    })).toEqual({ kind: "ready", value: { threadId: thread.id } });
    expect(starts).toBe(0);
  });

  test("recovers a lost thread-start response and never launches a replacement", async () => {
    let reconciliations = 0;
    let starts = 0;
    const launcher = new SessionDispatchLauncher(port({
      reconcileThread: () => {
        reconciliations += 1;
        return Promise.resolve(
          reconciliations === 1 ? { kind: "missing" } : { kind: "ready", thread },
        );
      },
      startThread: () => {
        starts += 1;
        return Promise.reject(
          Object.assign(new Error("response lost"), { code: "upstream_ambiguous" }),
        );
      },
    }));

    expect(await launcher.ensureThread({
      accountProfileId: "acct_primary0001",
      runId: "run_primary0001",
      title: "Task",
      workspacePath: "/private/lane",
    })).toEqual({ kind: "ready", value: { threadId: thread.id } });
    expect({ reconciliations, starts }).toEqual({ reconciliations: 2, starts: 1 });
  });

  test("quarantines an unprovable turn start instead of retrying it", async () => {
    let reconciliations = 0;
    let starts = 0;
    const reconciliationInputs: Array<{
      readonly clientUserMessageId: string;
      readonly threadId: string;
    }> = [];
    const launcher = new SessionDispatchLauncher(port({
      reconcileInitialTurn: (threadId, clientUserMessageId) => {
        reconciliations += 1;
        reconciliationInputs.push({ clientUserMessageId, threadId });
        return Promise.resolve(
          reconciliations === 1
            ? { kind: "missing", generation: 2, responsePosition: 11 }
            : {
                kind: "ambiguous",
                reason: "duplicate_client_message_id",
                generation: 2,
                responsePosition: 19,
              },
        );
      },
      startInitialTurn: () => {
        starts += 1;
        return Promise.reject(
          Object.assign(new Error("response lost"), { code: "upstream_ambiguous" }),
        );
      },
    }));

    expect(await launcher.ensureInitialTurn({
      clientUserMessageId: "message_primary0001",
      initialPrompt: "Do the work",
      runId: "run_primary0001",
      threadId: thread.id,
    })).toEqual({ kind: "ambiguous" });
    expect({ reconciliations, starts }).toEqual({ reconciliations: 2, starts: 1 });
    expect(reconciliationInputs).toEqual([
      { clientUserMessageId: "message_primary0001", threadId: thread.id },
      { clientUserMessageId: "message_primary0001", threadId: thread.id },
    ]);
  });

  test("quarantines an incomplete read before starting a duplicate turn", async () => {
    let starts = 0;
    const launcher = new SessionDispatchLauncher(port({
      reconcileInitialTurn: () => Promise.resolve({
        kind: "incomplete",
        reason: "partial_turn_items",
        generation: 3,
        responsePosition: 23,
      }),
      startInitialTurn: () => {
        starts += 1;
        return Promise.reject(new Error("must not replay an unprovable mutation"));
      },
    }));

    expect(await launcher.ensureInitialTurn({
      clientUserMessageId: "message_primary0001",
      initialPrompt: "Do the work",
      runId: "run_primary0001",
      threadId: thread.id,
    })).toEqual({ kind: "ambiguous" });
    expect(starts).toBe(0);
  });
});
