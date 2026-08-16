import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
} from "@hraness/agent-tasks-protocol";

import {
  DispatchActivityAdapter,
  dispatchActivityEventId,
} from "../src/dispatch/activity-adapter";
import type { SessionTurnActivity } from "../src/sessions/session-service";
import { applyMigrations } from "../src/state/database";
import { DispatchStore } from "../src/state/dispatch-store";

const reservation = {
  runId: "run_activity0001",
  taskId: "task_activity0001",
  taskKey: "OPS-7K2M4Q9",
  claimId: "claim_activity001",
  claimFence: 7,
  inputReviewRevision: 3,
  runtimePublicId: "runner_activity0001",
  runtimeBootId: "boot_activity0001",
  repositoryPublicId: "repo_activity0001",
} as const;

const activityBase = {
  accountProfileId: "acct_activity0001",
  threadId: "thread_activity0001",
  turnId: "turn_activity000001",
} as const;

function activityDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation, created_at, updated_at
    ) VALUES (?1, 'Fixture', 'signedIn', 1, ?2, ?2)
  `).run(activityBase.accountProfileId, "2026-07-20T12:00:00.000Z");
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES ('project_activity', '/fixture/repo', '/fixture/repo/.git',
      'Fixture', ?1, ?1)
  `).run("2026-07-20T12:00:00.000Z");
  return database;
}

function runningStore(database: Database): DispatchStore {
  const store = new DispatchStore(database);
  store.bindRepository({
    repositoryPublicId: reservation.repositoryPublicId,
    projectId: "project_activity",
    canonicalRepositoryPath: "/fixture/repo",
    canonicalGitCommonDir: "/fixture/repo/.git",
  });
  store.reserve(reservation);
  store.appendPublicEvent({ runId: reservation.runId, eventId: "run:1", kind: "run.queued" });
  store.appendPublicEvent({
    runId: reservation.runId,
    eventId: "run:2",
    kind: "worktree.preparing",
  });
  store.transition({
    runId: reservation.runId,
    to: "worktree_ready",
    accountProfileId: activityBase.accountProfileId,
  });
  store.appendPublicEvent({ runId: reservation.runId, eventId: "run:3", kind: "worktree.ready" });
  store.transition({ runId: reservation.runId, to: "thread_starting" });
  store.appendPublicEvent({ runId: reservation.runId, eventId: "run:4", kind: "codex.starting" });
  store.transition({
    runId: reservation.runId,
    to: "thread_ready",
    threadId: activityBase.threadId,
  });
  store.transition({ runId: reservation.runId, to: "turn_starting" });
  store.transition({
    runId: reservation.runId,
    to: "running",
    turnId: activityBase.turnId,
  });
  store.appendPublicEvent({ runId: reservation.runId, eventId: "run:5", kind: "codex.running" });
  return store;
}

function activity(
  kind: Exclude<SessionTurnActivity["kind"], "reasoning_summary_delta" | "assistant_message_delta">,
): SessionTurnActivity {
  return { ...activityBase, kind };
}

describe("dispatch activity adapter", () => {
  test("durably suppresses duplicate phases and transitions running through waiting", async () => {
    const database = activityDatabase();
    try {
      const store = runningStore(database);
      const adapter = new DispatchActivityAdapter({
        store,
        fence: { assertCurrent: () => Promise.resolve(true) },
      });

      await adapter.observe(activity("planning"));
      await adapter.observe(activity("planning"));
      await adapter.observe(activity("waiting_for_approval"));
      await adapter.observe(activity("waiting_for_approval"));
      expect(store.read(reservation.runId)?.stage).toBe("waiting");
      await adapter.observe(activity("testing"));
      expect(store.read(reservation.runId)?.stage).toBe("running");

      const semanticEvents = store.pendingEventsForRun(reservation.runId).slice(5);
      expect(semanticEvents.map(({ kind }) => kind)).toEqual([
        "codex.planning",
        "codex.waiting_for_approval",
        "codex.testing",
      ]);
      expect(semanticEvents.map(({ eventId }) => eventId)).toEqual(
        semanticEvents.map(({ kind, sequence }) => (
          dispatchActivityEventId(reservation.runId, sequence, kind)
        )),
      );

      // A fresh adapter derives duplicate suppression from durable outbox state,
      // not process memory.
      const restarted = new DispatchActivityAdapter({
        store,
        fence: { assertCurrent: () => Promise.resolve(true) },
      });
      await restarted.observe(activity("testing"));
      expect(store.pendingEventsForRun(reservation.runId).slice(5)).toEqual(semanticEvents);
      expect(store.latestPublicEvent(reservation.runId)?.kind).toBe("codex.testing");
    } finally {
      database.close();
    }
  });

  test("requires exact ownership and a current complete fence before persisting", async () => {
    const database = activityDatabase();
    try {
      const store = runningStore(database);
      let fenceChecks = 0;
      const adapter = new DispatchActivityAdapter({
        store,
        fence: {
          assertCurrent: () => {
            fenceChecks += 1;
            return Promise.resolve(false);
          },
        },
      });

      await adapter.observe({ ...activity("editing"), threadId: "thread_someone_else" });
      expect(fenceChecks).toBe(0);
      await adapter.observe(activity("editing"));
      expect(fenceChecks).toBe(1);
      expect(store.pendingEventsForRun(reservation.runId).map(({ kind }) => kind)).toEqual([
        "run.queued",
        "worktree.preparing",
        "worktree.ready",
        "codex.starting",
        "codex.running",
      ]);
    } finally {
      database.close();
    }
  });

  test("the persisted and wire-ready activity surface contains no raw Codex data", async () => {
    const database = activityDatabase();
    try {
      const store = runningStore(database);
      const adapter = new DispatchActivityAdapter({
        store,
        fence: { assertCurrent: () => Promise.resolve(true) },
      });
      await adapter.observe(activity("waiting_for_input"));

      const events = store.pendingEventsForRun(reservation.runId).slice(5);
      expect(events.map(({ kind }) => kind)).toEqual(["codex.waiting_for_input"]);
      const serialized = JSON.stringify(events);
      for (const forbidden of [
        "provider-thread",
        "provider-turn",
        "itemId",
        "questions",
        "command",
        "output",
        "/fixture/",
        "TOKEN=",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(Object.keys(events[0] ?? {}).toSorted()).toEqual([
        "createdAt",
        "eventId",
        "kind",
        "runId",
        "sequence",
        "summary",
      ]);
    } finally {
      database.close();
    }
  });

  test("local semantic event IDs are deterministic without provider identifiers", () => {
    const first = dispatchActivityEventId(reservation.runId, 6, "codex.editing");
    expect(first).toBe(dispatchActivityEventId(reservation.runId, 6, "codex.editing"));
    expect(first).not.toBe(dispatchActivityEventId(reservation.runId, 7, "codex.editing"));
    expect(first).not.toContain(reservation.runId);
  });

  test("a restarted adapter closes a durable tool span before later public text", async () => {
    const database = activityDatabase();
    try {
      const store = runningStore(database);
      const first = new DispatchActivityAdapter({
        store,
        fence: { assertCurrent: () => Promise.resolve(true) },
      });
      await first.observe(activity("tool_activity_started"));
      const restarted = new DispatchActivityAdapter({
        store: new DispatchStore(database),
        fence: { assertCurrent: () => Promise.resolve(true) },
      });
      await restarted.observe({
        ...activityBase,
        kind: "assistant_message_delta",
        displayText: "Finished after restart.",
      });
      store.materializeDisplayDraft(reservation.runId);
      expect(store.pendingEventsForRun(reservation.runId).slice(5).map(({ kind }) => kind))
        .toEqual([
          "codex.tool_activity.started",
          "codex.tool_activity.completed",
          "codex.assistant_message.delta",
        ]);
    } finally {
      database.close();
    }
  });

  test("keeps an anonymous tool span open through semantic statuses and suppresses orphan closes", async () => {
    const database = activityDatabase();
    try {
      const store = runningStore(database);
      const adapter = new DispatchActivityAdapter({
        store,
        fence: { assertCurrent: () => Promise.resolve(true) },
      });

      await adapter.observe(activity("tool_activity_started"));
      await adapter.observe(activity("editing"));
      expect(store.hasOpenToolActivity(reservation.runId)).toBeTrue();
      await adapter.observe(activity("tool_activity_completed"));
      await adapter.observe(activity("tool_activity_completed"));

      expect(store.pendingEventsForRun(reservation.runId).slice(5).map(({ kind }) => kind))
        .toEqual([
          "codex.tool_activity.started",
          "codex.editing",
          "codex.tool_activity.completed",
        ]);
      expect(store.hasOpenToolActivity(reservation.runId)).toBeFalse();
      expect(store.toolActivityEventCount(reservation.runId)).toBe(2);
    } finally {
      database.close();
    }
  });

  test("coalesces activity once terminal capacity is reserved", async () => {
    const database = activityDatabase();
    try {
      const store = runningStore(database);
      for (let sequence = 6; sequence <= 96; sequence += 1) {
        store.appendPublicEvent({
          runId: reservation.runId,
          eventId: `fill:${String(sequence)}`,
          kind: sequence % 2 === 0 ? "codex.planning" : "codex.editing",
        });
      }
      const adapter = new DispatchActivityAdapter({
        store,
        fence: { assertCurrent: () => Promise.resolve(true) },
      });
      await adapter.observe(activity("testing"));
      expect(store.read(reservation.runId)?.lastEventSequence).toBe(96);
      expect(store.latestPublicEvent(reservation.runId)?.kind).toBe("codex.planning");
    } finally {
      database.close();
    }
  });

  test("never starts an anonymous tool timer without reserving its completion slot", async () => {
    for (const existingCount of [MAX_RUN_DISPLAY_EVENTS - 2, MAX_RUN_DISPLAY_EVENTS - 1]) {
      const database = activityDatabase();
      try {
        const store = runningStore(database);
        for (let index = 0; index < existingCount; index += 1) {
          store.appendDisplayDelta({
            runId: reservation.runId,
            kind: index % 2 === 0
              ? "codex.reasoning_summary.delta"
              : "codex.assistant_message.delta",
            displayText: "x".repeat(MAX_RUN_DISPLAY_TEXT_UTF8_BYTES),
          });
        }
        store.materializeDisplayDraft(reservation.runId);
        const adapter = new DispatchActivityAdapter({
          store,
          fence: { assertCurrent: () => Promise.resolve(true) },
        });
        await adapter.observe(activity("tool_activity_started"));
        if (existingCount === MAX_RUN_DISPLAY_EVENTS - 1) {
          expect(store.latestPublicEvent(reservation.runId)?.kind)
            .not.toBe("codex.tool_activity.started");
          expect(store.displayEventCount(reservation.runId)).toBe(existingCount);
          continue;
        }
        expect(store.latestPublicEvent(reservation.runId)?.kind)
          .toBe("codex.tool_activity.started");
        await adapter.observe(activity("tool_activity_completed"));
        expect(store.latestPublicEvent(reservation.runId)?.kind)
          .toBe("codex.tool_activity.completed");
        expect(store.displayEventCount(reservation.runId)).toBe(MAX_RUN_DISPLAY_EVENTS);
      } finally {
        database.close();
      }
    }
  });

  test("reserves both sequence slots for every admitted anonymous tool span", async () => {
    for (const lastSequence of [94, 95]) {
      const database = activityDatabase();
      try {
        const store = runningStore(database);
        for (let sequence = 6; sequence <= lastSequence; sequence += 1) {
          store.appendPublicEvent({
            runId: reservation.runId,
            eventId: `phase:${String(sequence)}`,
            kind: sequence % 2 === 0 ? "codex.planning" : "codex.running",
          });
        }
        const adapter = new DispatchActivityAdapter({
          store,
          fence: { assertCurrent: () => Promise.resolve(true) },
        });
        await adapter.observe(activity("tool_activity_started"));
        if (lastSequence === 95) {
          expect(store.read(reservation.runId)?.lastEventSequence).toBe(95);
          expect(store.latestPublicEvent(reservation.runId)?.kind)
            .not.toBe("codex.tool_activity.started");
          continue;
        }
        expect(store.read(reservation.runId)?.lastEventSequence).toBe(95);
        await adapter.observe(activity("editing"));
        expect(store.read(reservation.runId)?.lastEventSequence).toBe(95);
        expect(store.hasOpenToolActivity(reservation.runId)).toBeTrue();
        await adapter.observe(activity("tool_activity_completed"));
        expect(store.read(reservation.runId)?.lastEventSequence).toBe(96);
        expect(store.latestPublicEvent(reservation.runId)?.kind)
          .toBe("codex.tool_activity.completed");
        expect(store.hasOpenToolActivity(reservation.runId)).toBeFalse();
      } finally {
        database.close();
      }
    }
  });
});
