import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { Database } from "bun:sqlite";

import type { WorkEvidence } from "../domain/work";

export type WorkEvidenceVerificationErrorCode =
  | "EVIDENCE_INVALID"
  | "MEMBER_NOT_FOUND"
  | "ROUTE_MISMATCH";

export class WorkEvidenceVerificationError extends Error {
  constructor(readonly code: WorkEvidenceVerificationErrorCode) {
    super(code);
    this.name = "WorkEvidenceVerificationError";
  }
}

type ProjectRow = Readonly<{ root_path: string }>;

const requireMember = (database: Database, workId: string, sessionId: string): void => {
  const member = database.query(
    "SELECT 1 AS present FROM work_members WHERE work_id=? AND session_id=?",
  ).get(workId, sessionId) as { present: number } | null;
  if (member === null) throw new WorkEvidenceVerificationError("MEMBER_NOT_FOUND");
};

const requireProjectRoot = (
  database: Database,
  workId: string,
  projectId: string,
  taskProjectId: string | null,
): string => {
  if (taskProjectId !== null && projectId !== taskProjectId) {
    throw new WorkEvidenceVerificationError("ROUTE_MISMATCH");
  }
  if (taskProjectId === null) {
    const routed = database.query(
      "SELECT 1 AS present FROM work_tasks WHERE work_id=? AND project_id=? LIMIT 1",
    ).get(workId, projectId) as { present: number } | null;
    if (routed === null) throw new WorkEvidenceVerificationError("ROUTE_MISMATCH");
  }
  const project = database.query(
    "SELECT root_path FROM projects WHERE id=?",
  ).get(projectId) as ProjectRow | null;
  if (project === null) throw new WorkEvidenceVerificationError("ROUTE_MISMATCH");
  try {
    return realpathSync(project.root_path);
  } catch {
    throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
  }
};

const verifyTurn = (
  database: Database,
  sessionId: string,
  turnId: string,
): void => {
  const event = database.query(
    `SELECT 1 AS present FROM session_events
     WHERE session_id=? AND json_extract(event_json,'$.body.turnId')=? LIMIT 1`,
  ).get(sessionId, turnId) as { present: number } | null;
  if (event === null) throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
};

const verifyArtifact = (
  root: string,
  path: string,
  expectedBytes: number,
  expectedDigest: string,
): void => {
  let descriptor: number | null = null;
  try {
    const resolved = realpathSync(resolve(root, path));
    const withinRoot = relative(root, resolved);
    if (withinRoot === "" || withinRoot === ".." || withinRoot.startsWith("../") || isAbsolute(withinRoot)) {
      throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
    }
    descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== expectedBytes) {
      throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let observedBytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      observedBytes += count;
      if (observedBytes > expectedBytes) {
        throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
      }
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (
      observedBytes !== expectedBytes
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || digest.digest("hex") !== expectedDigest
    ) throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
  } catch (error: unknown) {
    if (error instanceof WorkEvidenceVerificationError) throw error;
    throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

const verifyGitCommit = (root: string, commit: string): void => {
  const result = spawnSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "safe.directory=*",
      "-C",
      root,
      "cat-file",
      "-e",
      `${commit}^{commit}`,
    ],
    {
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stdio: "ignore",
      timeout: 5_000,
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    throw new WorkEvidenceVerificationError("EVIDENCE_INVALID");
  }
};

/**
 * Resolve every closed evidence reference against state or local project contents.
 * A successful return proves existence and identity, not semantic relevance.
 */
export function verifyWorkEvidence(
  database: Database,
  workId: string,
  evidence: readonly WorkEvidence[],
  taskId?: string,
): void {
  const taskProjectId = taskId === undefined
    ? null
    : (database.query(
      "SELECT project_id FROM work_tasks WHERE id=? AND work_id=?",
    ).get(taskId, workId) as { project_id: string } | null)?.project_id;
  if (taskId !== undefined && taskProjectId === undefined) {
    throw new WorkEvidenceVerificationError("ROUTE_MISMATCH");
  }
  for (const item of evidence) {
    if (item.kind === "session") {
      requireMember(database, workId, item.sessionId);
      continue;
    }
    if (item.kind === "turn") {
      requireMember(database, workId, item.sessionId);
      verifyTurn(database, item.sessionId, item.turnId);
      continue;
    }
    const root = requireProjectRoot(
      database,
      workId,
      item.projectId,
      taskProjectId ?? null,
    );
    if (item.kind === "artifact") {
      verifyArtifact(root, item.path, item.bytes, item.sha256);
    } else {
      verifyGitCommit(root, item.commit);
    }
  }
}
