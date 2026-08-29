import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { Database } from "bun:sqlite";

import { workEvidenceListSchema, type WorkEvidence } from "../domain/work";
import {
  verifyWorkEvidence,
  WorkEvidenceVerificationError,
} from "./work-evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "hra-work-evidence-"));
  roots.push(root);
  const artifact = Buffer.from("verified artifact\n", "utf8");
  writeFileSync(join(root, "result.txt"), artifact);
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "HRA Test");
  git(root, "config", "user.email", "hra@example.invalid");
  git(root, "add", "result.txt");
  git(root, "commit", "--quiet", "-m", "evidence");
  const commit = git(root, "rev-parse", "HEAD");

  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,root_path TEXT NOT NULL);
    CREATE TABLE work_tasks(id TEXT PRIMARY KEY,work_id TEXT NOT NULL,project_id TEXT NOT NULL);
    CREATE TABLE work_members(work_id TEXT NOT NULL,session_id TEXT NOT NULL);
    CREATE TABLE session_events(session_id TEXT NOT NULL,event_json TEXT NOT NULL);
  `);
  database.query("INSERT INTO projects(id,root_path) VALUES (?,?)").run("project", root);
  database.query(
    "INSERT INTO work_tasks(id,work_id,project_id) VALUES ('task','work','project')",
  ).run();
  database.query(
    "INSERT INTO work_members(work_id,session_id) VALUES ('work','session')",
  ).run();
  const turnId = `opaque_v2_${"a".repeat(64)}`;
  database.query("INSERT INTO session_events(session_id,event_json) VALUES (?,?)").run(
    "session",
    JSON.stringify({ body: { type: "turn_started", turnId } }),
  );
  const evidence = workEvidenceListSchema.parse([
    { kind: "session", sessionId: `sess_${"1".repeat(32)}` },
  ]);
  return {
    artifact,
    commit,
    database,
    root,
    turnId,
    verified: [
      { kind: "artifact", projectId: "project", path: "result.txt", bytes: artifact.length,
        sha256: createHash("sha256").update(artifact).digest("hex") },
      { kind: "git_commit", projectId: "project", commit },
    ] as WorkEvidence[],
    evidence,
  };
};

describe("work evidence verification", () => {
  test("resolves turn, artifact digest, and exact Git commit evidence", () => {
    const value = fixture();
    expect(() => verifyWorkEvidence(value.database, "work", [
      { kind: "turn", sessionId: "session" as `sess_${string}`, turnId: value.turnId },
      ...value.verified,
    ], "task")).not.toThrow();
  });

  test("rejects missing turns, mismatched content, routes, and non-commit objects", () => {
    const value = fixture();
    const cases: WorkEvidence[][] = [
      [{ kind: "turn", sessionId: "session" as `sess_${string}`,
        turnId: `opaque_v2_${"b".repeat(64)}` }],
      [{ ...value.verified[0]!, sha256: "0".repeat(64) } as WorkEvidence],
      [{ ...value.verified[0]!, projectId: "different" } as WorkEvidence],
      [{ kind: "git_commit", projectId: "project", commit: "0".repeat(40) }],
    ];
    for (const evidence of cases) {
      expect(() => verifyWorkEvidence(value.database, "work", evidence, "task"))
        .toThrow(WorkEvidenceVerificationError);
    }
  });
});
