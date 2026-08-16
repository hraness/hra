import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHAT_MAX_PANES } from "../src/chat";
import { applyMigrations } from "../src/state/database";
import { ChatPaneStore } from "../src/state/chat-pane-store";

const ACCOUNT = "acct_streamperf001";
const REPOSITORY = `repo_${"7".repeat(26)}`;
const NOW = new Date("2026-08-09T12:00:00.000Z");
const CHUNKS_PER_PANE = 16;
const CHUNK = "x".repeat(4 * 1024);

test("file-backed FULL SQLite co-commit bounds stream write amplification across 64 panes", () => {
  const root = mkdtempSync(join(tmpdir(), "oprte-chat-stream-"));
  try {
    const scalar = exercise(join(root, "scalar.sqlite"), false);
    const batched = exercise(join(root, "batched.sqlite"), true);

    expect(batched.finalBytes).toBe(scalar.finalBytes);
    expect(batched.finalRevision).toBe(scalar.finalRevision);
    expect(batched.walFrames).toBeLessThan(scalar.walFrames / 4);
    expect(batched.elapsedMilliseconds).toBeLessThan(10_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function exercise(
  path: string,
  batched: boolean,
): Readonly<{
  elapsedMilliseconds: number;
  finalBytes: number;
  finalRevision: number;
  walFrames: number;
}> {
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
      PRAGMA wal_autocheckpoint = 0;
    `);
    applyMigrations(database);
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Stream performance', 'signed_in', 1, 1, ?2, ?2)
    `).run(ACCOUNT, NOW.toISOString());
    const store = new ChatPaneStore(database);
    const fixtures = Array.from({ length: CHAT_MAX_PANES }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      const paneId = `pane_streamperf${suffix}`;
      const turnId = `chatturn_streamperf${suffix}`;
      const created = store.create({
        paneId,
        repository: {
          id: REPOSITORY,
          name: "Stream performance",
          workingDirectory: "/fixture/stream-performance",
        },
        accountProfileId: ACCOUNT,
        reasoningEffort: "ultra",
        now: NOW,
      });
      store.beginTurn({
        paneId,
        expectedRevision: created.revision,
        turnId,
        prompt: "performance prompt",
        now: NOW,
      });
      store.reserveAccount(paneId, turnId, ACCOUNT, NOW);
      store.prepareProviderThread(paneId, turnId, {
        accountProfileId: ACCOUNT,
        threadId: `thread_streamperf${suffix}`,
        restartThreadId: `raw_thread_streamperf${suffix}`,
      }, NOW);
      const accepted = store.markTurnAccepted(
        paneId,
        turnId,
        `turn_streamperf${suffix}`,
        NOW,
      );
      return { paneId, turnId, acceptedRevision: accepted.revision };
    });
    database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();

    const startedAt = performance.now();
    if (batched) {
      const outcomes = store.appendDeltaBatches(fixtures.map(({ paneId, turnId }, index) => ({
        paneId,
        turnId,
        channel: "responseMarkdown" as const,
        deltas: Array.from({ length: CHUNKS_PER_PANE }, () => CHUNK),
        assistantMessageId: `item_streamperf${String(index).padStart(2, "0")}`,
        now: NOW,
      })));
      expect(outcomes.every(({ kind }) => kind === "written")).toBeTrue();
    } else {
      for (const [index, { paneId, turnId }] of fixtures.entries()) {
        for (let chunk = 0; chunk < CHUNKS_PER_PANE; chunk += 1) {
          store.appendDelta({
            paneId,
            turnId,
            channel: "responseMarkdown",
            delta: CHUNK,
            assistantMessageId: `item_streamperf${String(index).padStart(2, "0")}`,
            now: NOW,
          });
        }
      }
    }
    const elapsedMilliseconds = performance.now() - startedAt;
    const checkpoint = database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    const first = fixtures[0];
    if (first === undefined) throw new Error("Missing stream fixture");
    const final = store.require(first.paneId).projection;
    return {
      elapsedMilliseconds,
      finalBytes: final.turn?.responseMarkdown.totalUtf8Bytes ?? -1,
      finalRevision: final.revision - first.acceptedRevision,
      walFrames: checkpoint.log,
    };
  } finally {
    database.close();
  }
}
