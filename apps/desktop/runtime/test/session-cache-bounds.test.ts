import { expect, test } from "bun:test";

import { createCodexFactsAtPosition, type CodexFact } from "../src/codex";
import type { GatewaySessionEvent, ProjectSummary } from "../src/internal-contracts";
import { SessionFactDispatchAdapter } from "../src/sessions/fact-dispatch-adapter";
import { ownedCodexId } from "../src/sessions/identity";
import {
  createSessionState,
  sessionEntityKey,
  type SessionThreadState,
  type SessionTurnState,
} from "../src/sessions/model";
import {
  MAX_SESSION_REGISTRY_PROJECTS,
  SessionRegistry,
} from "../src/sessions/session-registry";

const timestamp = "2026-07-29T12:00:00.000Z";

test("display revisions use bounded per-account clocks and reset on authorized purge", () => {
  const events: GatewaySessionEvent[] = [];
  const adapter = new SessionFactDispatchAdapter({
    admit: () => true,
    emit: (event) => events.push(event),
  });
  const delta = (
    accountProfileId: string,
    streamPosition: number,
    itemId: string,
  ): CodexFact => createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "live",
    streamPosition,
  }, [{
    type: "item.delta",
    channel: "assistant_text",
    delta: "safe display",
    itemId,
    threadId: "provider-thread",
    truncated: false,
    turnId: "provider-turn",
  }])[0]!;

  expect(adapter.consume(delta("acct_first", 1, "item-a"))).toBeTrue();
  expect(adapter.consume(delta("acct_first", 2, "item-b"))).toBeTrue();
  expect(adapter.consume(delta("acct_second", 1, "item-a"))).toBeTrue();
  adapter.purgeAccount("acct_first");
  expect(adapter.consume(delta("acct_first", 3, "item-c"))).toBeTrue();

  expect(events.flatMap((event) => event.type === "item.delta"
    ? [{ account: event.itemId, revision: event.revision }]
    : [])).toEqual([
    { account: ownedCodexId("item", "acct_first", "item-a"), revision: 1 },
    { account: ownedCodexId("item", "acct_first", "item-b"), revision: 2 },
    { account: ownedCodexId("item", "acct_second", "item-a"), revision: 1 },
    { account: ownedCodexId("item", "acct_first", "item-c"), revision: 1 },
  ]);
});

test("registry retains only current active-turn routing and caps referenced projects", () => {
  let state = createSessionState();
  const registry = new SessionRegistry({
    emit: () => undefined,
    errors: {
      capacity: (message) => new Error(`capacity: ${message}`),
      missingThread: (message) => new Error(`missing: ${message}`),
      protocol: (message) => new Error(`protocol: ${message}`),
    },
    getSnapshot: () => state,
    onTurnLifecycle: () => undefined,
  });
  const installThread = (
    accountProfileId: string,
    threadId: string,
    cwd: string,
    turns: readonly Readonly<{
      id: string;
      status: SessionTurnState["status"];
    }>[] = [],
  ): void => {
    const threadKey = sessionEntityKey(accountProfileId, threadId);
    const nextTurns = { ...state.turns };
    const turnKeys: string[] = [];
    for (const turn of turns) {
      const turnKey = sessionEntityKey(accountProfileId, turn.id);
      turnKeys.push(turnKey);
      nextTurns[turnKey] = {
        accountProfileId,
        activity: null,
        completedAt: turn.status === "active" ? null : timestamp,
        id: turn.id,
        itemKeys: Object.freeze([]),
        startedAt: timestamp,
        status: turn.status,
        threadKey,
      };
    }
    const thread: SessionThreadState = {
      accountProfileId,
      archived: false,
      createdAt: timestamp,
      cwd,
      id: threadId,
      status: turns.at(-1)?.status === "active" ? "active" : "idle",
      title: threadId,
      turnKeys: Object.freeze(turnKeys),
      updatedAt: timestamp,
    };
    state = {
      ...state,
      threads: { ...state.threads, [threadKey]: thread },
      turns: nextTurns,
    };
  };

  const accountProfileId = "acct_active";
  const threadId = "provider-thread";
  const cwd = "/fixture/active";
  const project = registry.ensureProject(cwd, timestamp);
  installThread(accountProfileId, threadId, cwd, [{ id: "turn-a", status: "active" }]);
  const first = registry.observeThread({
    accountProfileId,
    codexThreadId: threadId,
    preferredProject: project,
  });
  const firstTurnId = ownedCodexId("turn", accountProfileId, "turn-a");
  expect(registry.rawTurnIdByOwnedId(firstTurnId)).toBe("turn-a");

  installThread(accountProfileId, threadId, cwd, [
    { id: "turn-a", status: "completed" },
    { id: "turn-b", status: "active" },
  ]);
  const second = registry.observeThread({
    accountProfileId,
    codexThreadId: threadId,
    preferredProject: project,
  });
  const secondTurnId = ownedCodexId("turn", accountProfileId, "turn-b");
  expect(registry.rawTurnIdByOwnedId(firstTurnId)).toBeNull();
  expect(registry.rawTurnIdByOwnedId(secondTurnId)).toBe("turn-b");

  installThread(accountProfileId, threadId, cwd);
  const metadataOnly = registry.observeThread({
    accountProfileId,
    codexThreadId: threadId,
    preferredProject: project,
  });
  expect(metadataOnly.activeTurn?.id).toBe(secondTurnId);
  expect(registry.rawTurnIdByOwnedId(secondTurnId)).toBe("turn-b");

  const authoritativeEmpty = registry.observeThread({
    accountProfileId,
    authoritativeTurns: true,
    codexThreadId: threadId,
    preferredProject: project,
  });
  expect(authoritativeEmpty.activeTurn).toBeNull();
  expect(registry.rawTurnIdByOwnedId(secondTurnId)).toBeNull();
  expect([
    first.revision,
    second.revision,
    metadataOnly.revision,
    authoritativeEmpty.revision,
  ]).toEqual([2, 4, 5, 6]);

  expect(registry.purgeAccount(accountProfileId)).toBe(1);
  installThread(accountProfileId, "after-purge", "/fixture/after-purge");
  const retainedProjects: Array<Readonly<{
    accountProfileId: string;
    project: ProjectSummary;
    threadId: string;
  }>> = [];
  const afterPurgeProject = registry.ensureProject("/fixture/after-purge", timestamp);
  const afterPurge = registry.observeThread({
    accountProfileId,
    codexThreadId: "after-purge",
    preferredProject: afterPurgeProject,
  });
  expect(afterPurge.revision).toBe(1);
  retainedProjects.push({
    accountProfileId,
    project: afterPurgeProject,
    threadId: "after-purge",
  });

  for (let index = 1; index < MAX_SESSION_REGISTRY_PROJECTS; index += 1) {
    const indexedAccountId = `acct_capacity_${String(index)}`;
    const indexedThreadId = `thread-${String(index)}`;
    const indexedCwd = `/fixture/capacity/${String(index)}`;
    installThread(indexedAccountId, indexedThreadId, indexedCwd);
    const indexedProject = registry.ensureProject(indexedCwd, timestamp);
    registry.observeThread({
      accountProfileId: indexedAccountId,
      codexThreadId: indexedThreadId,
      preferredProject: indexedProject,
    });
    retainedProjects.push({
      accountProfileId: indexedAccountId,
      project: indexedProject,
      threadId: indexedThreadId,
    });
  }
  expect(() => registry.ensureProject("/fixture/capacity/rejected", timestamp))
    .toThrow("Too many active local folders");

  const released = retainedProjects[0]!;
  expect(registry.removeThread(released.accountProfileId, released.threadId)).not.toBeNull();
  expect(registry.projectById(released.project.id)).toBeNull();
  expect(registry.ensureProject("/fixture/capacity/replacement", timestamp).displayPath)
    .toBe("/fixture/capacity/replacement");
  expect(registry.projectById(retainedProjects[1]!.project.id)).not.toBeNull();
});
