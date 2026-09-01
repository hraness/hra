import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditSessions, parseSessionArguments } from "./session-audit";

describe("session audit arguments", () => {
  test("uses a 24-hour review boundary by default", () => {
    expect(parseSessionArguments(["--codex-home", "/tmp/codex"]))
      .toMatchObject({ codexHome: "/tmp/codex", limit: 30, staleHours: 24 });
  });

  test("bounds report size and silence threshold", () => {
    expect(() => parseSessionArguments(["--limit=0"]))
      .toThrow("1 through 500");
    expect(() => parseSessionArguments(["--stale-hours=0"]))
      .toThrow("positive");
  });

  test("separates support and pinned tasks while bounding private metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-session-audit-"));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const database = new Database(join(codexHome, "state_5.sqlite"), { create: true });
    database.run(
      `CREATE TABLE threads (
         id TEXT NOT NULL,
         title TEXT NOT NULL,
         cwd TEXT NOT NULL,
         source TEXT NOT NULL,
         agent_role TEXT,
         thread_section_id TEXT,
         updated_at_ms INTEGER NOT NULL,
         archived INTEGER NOT NULL,
         preview TEXT NOT NULL
       )`,
    );
    const insert = database.query(
      `INSERT INTO threads
       (id, title, cwd, source, agent_role, thread_section_id, updated_at_ms, archived, preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'visible')`,
    );
    const now = Date.UTC(2026, 7, 31, 12);
    insert.run("root-stale", `${"private ".repeat(40)}\ntranscript`, `/repo/${"nested/".repeat(60)}`, "vscode", null, null, now - 48 * 3_600_000);
    insert.run("root-pinned", "Reference task", "/repo", "exec", null, "pinned", now - 72 * 3_600_000);
    insert.run("root-fresh", "Fresh task", "/repo", "vscode", null, null, now - 60_000);
    insert.run("support", "Guardian", "/repo", '{"subagent":{"other":"guardian"}}', "guardian", null, now - 96 * 3_600_000);
    database.close();

    try {
      const result = auditSessions({ codexHome, json: true, limit: 30, staleHours: 24 }, now);
      expect(result).toMatchObject({
        pinnedSilentCount: 1,
        silentCount: 2,
        statusAuthority: "heuristic-only",
        supportTaskCount: 1,
        userTaskCount: 3,
        version: 2,
      });
      expect(result.silent.map((thread) => thread.id)).toEqual(["root-pinned", "root-stale"]);
      expect(result.silent.map((thread) => thread.reviewKind))
        .toEqual(["pinned-review-candidate", "review-candidate"]);
      expect(result.silent.every((thread) => !thread.source.startsWith('{"subagent":'))).toBe(true);
      expect(Array.from(result.silent[1]?.title ?? "")).toHaveLength(120);
      expect(result.silent[1]?.title).not.toContain("\n");
      expect(Array.from(result.silent[1]?.cwd ?? "").length).toBeLessThanOrEqual(240);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers current thread_source metadata without treating support history as active work", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-session-current-source-"));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const database = new Database(join(codexHome, "state_5.sqlite"), { create: true });
    database.run(
      `CREATE TABLE threads (
         id TEXT NOT NULL,
         title TEXT NOT NULL,
         cwd TEXT NOT NULL,
         source TEXT NOT NULL,
         thread_source TEXT,
         agent_role TEXT,
         is_pinned INTEGER NOT NULL,
         thread_section_id TEXT,
         updated_at_ms INTEGER NOT NULL,
         archived INTEGER NOT NULL,
         preview TEXT NOT NULL
       )`,
    );
    const now = Date.UTC(2026, 7, 31, 12);
    const insert = database.query(
      `INSERT INTO threads VALUES (?, ?, '/repo', 'exec', ?, NULL, ?, NULL, ?, 0, 'visible')`,
    );
    insert.run("user", "User task", "user", 0, now - 48 * 3_600_000);
    insert.run("guardian", "Guardian review", "guardian_review", 0, now - 48 * 3_600_000);
    insert.run("subagent", "Worker", "subagent", 0, now - 48 * 3_600_000);
    database.close();
    try {
      const result = auditSessions({ codexHome, json: true, limit: 30, staleHours: 24 }, now);
      expect(result).toMatchObject({ silentCount: 1, supportTaskCount: 2, userTaskCount: 1 });
      expect(result.silent.map((thread) => thread.id)).toEqual(["user"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
