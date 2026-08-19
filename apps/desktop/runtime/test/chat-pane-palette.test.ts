import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import { migrations } from "../src/state/migrations";

const ACCOUNT = "acct_paletteidentity1";
const EARLY = "2026-08-18T11:59:59.000Z";
const TIED = "2026-08-18T12:00:00.000Z";

test("palette identity backfills deterministically and never follows display order", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of migrations) {
      if (migration.version >= 49) break;
      database.exec(migration.sql);
    }
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Palette', 'signed_in', 1, 1, ?2, ?2)
    `).run(ACCOUNT, TIED);
    const insert = database.query(`
      INSERT INTO chat_panes (
        pane_id, display_order, repository_id, repository_name, revision, title,
        account_profile_id, model, reasoning_effort, service_tier,
        interaction_mode, state,
        workspace_mode, workspace_state, workspace_revision,
        workspace_recovery_reason, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 1, ?4, ?5, 'gpt-5.6-sol', 'max', 'standard',
        'chat', 'ready', 'managed_worktree', 'preparing', 1, NULL, ?6, ?6
      )
    `);
    insert.run(
      "pane_paletteidentityc",
      2,
      `repo_${"C".repeat(26)}`,
      "Early",
      ACCOUNT,
      EARLY,
    );
    insert.run(
      "pane_paletteidentitya",
      1,
      `repo_${"A".repeat(26)}`,
      "Tie A",
      ACCOUNT,
      TIED,
    );
    insert.run(
      "pane_paletteidentityb",
      0,
      `repo_${"B".repeat(26)}`,
      "Tie B",
      ACCOUNT,
      TIED,
    );
    for (const migration of migrations) {
      if (migration.version < 49) continue;
      database.exec(migration.sql);
    }

    expect(database.query(`
      SELECT pane_id, palette_index FROM chat_panes
      ORDER BY palette_index
    `).all()).toEqual([
      { pane_id: "pane_paletteidentityc", palette_index: 0 },
      { pane_id: "pane_paletteidentitya", palette_index: 1 },
      { pane_id: "pane_paletteidentityb", palette_index: 2 },
    ]);

    const store = new ChatPaneStore(database);
    const created = store.create({
      paneId: "pane_paletteidentityd",
      repository: {
        id: `repo_${"D".repeat(26)}`,
        name: "New D",
        workingDirectory: "/fixture/palette-d",
      },
      accountProfileId: ACCOUNT,
      now: new Date("2026-08-18T12:00:01.000Z"),
    });
    expect(created.paletteIndex).toBe(3);
    const before = store.list();
    store.reorder(
      before.map(({ id }) => id),
      [...before].reverse().map(({ id }) => id),
    );
    expect(new Map(store.list().map(({ id, paletteIndex }) => [id, paletteIndex])))
      .toEqual(new Map([
        ["pane_paletteidentityc", 0],
        ["pane_paletteidentitya", 1],
        ["pane_paletteidentityb", 2],
        ["pane_paletteidentityd", 3],
      ]));

    store.remove("pane_paletteidentityd", created.revision, new Date(
      "2026-08-18T12:00:02.000Z",
    ));
    const next = store.create({
      paneId: "pane_paletteidentitye",
      repository: {
        id: `repo_${"E".repeat(26)}`,
        name: "New E",
        workingDirectory: "/fixture/palette-e",
      },
      accountProfileId: ACCOUNT,
      now: new Date("2026-08-18T12:00:03.000Z"),
    });
    expect(next.paletteIndex).toBe(4);
  } finally {
    database.close();
  }
});
