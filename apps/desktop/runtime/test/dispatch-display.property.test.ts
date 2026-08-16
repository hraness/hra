import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
} from "@hraness/agent-tasks-protocol";
import { fc } from "@hra-internal/test";

import { applyMigrations } from "../src/state/database";
import { DispatchStore } from "../src/state/dispatch-store";

const reservation = {
  runId: "run_displayprop01",
  taskId: "task_displayprop01",
  taskKey: "OPS-7K2M4Q9",
  claimId: "claim_displayprop1",
  claimFence: 7,
  inputReviewRevision: 3,
  runtimePublicId: "runner_displayprop1",
  runtimeBootId: "boot_displayprop01",
  repositoryPublicId: "repo_displayprop01",
} as const;

function createStoreFixture(): Uint8Array {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    database.query(`
      INSERT INTO projects (
        project_id, canonical_repository_path, canonical_git_common_dir,
        display_name, created_at, updated_at
      ) VALUES ('project_displayprop', '/fixture/repo', '/fixture/repo/.git',
        'Fixture', '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z')
    `).run();
    const store = new DispatchStore(database);
    store.bindRepository({
      repositoryPublicId: reservation.repositoryPublicId,
      projectId: "project_displayprop",
      canonicalRepositoryPath: "/fixture/repo",
      canonicalGitCommonDir: "/fixture/repo/.git",
    });
    store.reserve(reservation);
    return database.serialize();
  } finally {
    database.close();
  }
}

const pristineStoreFixture = createStoreFixture();

function withStore(run: (store: DispatchStore, database: Database) => void): void {
  const database = Database.deserialize(pristineStoreFixture.slice(), { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const store = new DispatchStore(database);
    run(store, database);
  } finally {
    database.close();
  }
}

const safeCharacter = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ🙂\n");
const fragment = fc.array(safeCharacter, { minLength: 1, maxLength: 40 })
  .map((characters) => characters.join(""));
const channel = fc.constantFrom(
  "codex.reasoning_summary.delta" as const,
  "codex.assistant_message.delta" as const,
);

test("arbitrary adjacent display fragments survive coalescing, restart, and replay in order", () => {
  fc.assert(fc.property(
    fc.array(fc.record({ channel, fragment }), { minLength: 1, maxLength: 40 }),
    (inputs) => withStore((store, database) => {
      for (const input of inputs) {
        store.appendDisplayDelta({
          runId: reservation.runId,
          kind: input.channel,
          displayText: input.fragment,
        });
      }
      const restarted = new DispatchStore(database);
      restarted.materializeDisplayDraft(reservation.runId);
      const firstRead = restarted.pendingEventsForRun(reservation.runId);
      const secondRead = new DispatchStore(database).pendingEventsForRun(reservation.runId);
      expect(secondRead).toEqual(firstRead);
      expect(firstRead.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: firstRead.length }, (_, index) => index + 1),
      );
      expect(firstRead.map(({ displayText }) => displayText ?? "").join(""))
        .toBe(inputs.map(({ fragment: value }) => value).join(""));
      expect(firstRead.every(({ eventId }) => !inputs.some(({ fragment: value }) => (
        value.length >= 8 && eventId.includes(value)
      )))).toBeTrue();
    }),
  ), { numRuns: 100 });
}, 15_000);

test("arbitrary text either persists through the strict display schema or leaves no draft", () => {
  fc.assert(fc.property(fc.string(), (value) => withStore((store) => {
    const forbidden = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint <= 31 && ![9, 10, 13].includes(codePoint)) || codePoint === 127;
    });
    const append = () => store.appendDisplayDelta({
      runId: reservation.runId,
      kind: "codex.assistant_message.delta",
      displayText: value,
    });
    if (forbidden) {
      expect(append).toThrow();
      expect(store.materializeDisplayDraft(reservation.runId)).toBeNull();
    } else {
      expect(append).not.toThrow();
    }
  })), {
    interruptAfterTimeLimit: 20_000,
    markInterruptAsFailure: true,
    numRuns: 100,
  });
}, 30_000);

test("one maximum ingress delta is linearly chunked to the exact lifetime event budget", () => {
  withStore((store) => {
    const delta = "x".repeat(MAX_RUN_DISPLAY_EVENTS * MAX_RUN_DISPLAY_TEXT_UTF8_BYTES);
    expect(store.appendDisplayDelta({
      runId: reservation.runId,
      kind: "codex.assistant_message.delta",
      displayText: delta,
    })).toBe(delta.length);
    store.materializeDisplayDraft(reservation.runId);
    expect(store.displayEventCount(reservation.runId)).toBe(MAX_RUN_DISPLAY_EVENTS);
    expect(store.pendingEventsForRun(reservation.runId, 25)).toHaveLength(25);
  });
});
