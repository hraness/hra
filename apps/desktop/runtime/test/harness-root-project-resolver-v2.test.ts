import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  HarnessRootProjectResolverV2Error,
  HarnessSQLiteRootProjectResolverV2,
  deriveHarnessProjectIdV2,
} from "../src/harness/root-project-resolver-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-02T00:00:00.000Z";
const repositoryId = `repo_${"1".repeat(26)}`;
const repositoryPath = "/tmp/oprte-root-project-resolver-v2";
const gitCommonDir = `${repositoryPath}/.git`;
const sourceSha = "a".repeat(40);

class ExactWorkspaceBroker {
  readonly calls: string[] = [];
  inspections: Array<Readonly<{
    canonicalRepositoryPath: string;
    canonicalGitCommonDir: string;
  }>> = [];
  resolvedSha = sourceSha;

  inspectRepository(path: string) {
    this.calls.push(`inspect:${path}`);
    return Promise.resolve(this.inspections.shift() ?? {
      canonicalRepositoryPath: repositoryPath,
      canonicalGitCommonDir: gitCommonDir,
    });
  }

  resolveBase(path: string, ref: string) {
    this.calls.push(`resolve:${path}:${ref}`);
    return Promise.resolve(this.resolvedSha);
  }
}

function fixture(options: Readonly<{
  path?: string;
  repositoryId?: string;
  gitCommonDir?: string;
}> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const registeredPath = options.path ?? repositoryPath;
  const registeredId = options.repositoryId ?? repositoryId;
  const registeredGitCommonDir = options.gitCommonDir ?? gitCommonDir;
  database.query(`
    INSERT INTO local_repositories (
      repository_id, name, provider, public_url,
      canonical_repository_path, canonical_git_common_dir,
      tombstoned_at, created_at, updated_at
    ) VALUES (?1, 'Root project', NULL, NULL, ?2, ?3, NULL, 1, 1)
  `).run(registeredId, registeredPath, registeredGitCommonDir);
  const workspaces = new ExactWorkspaceBroker();
  if (registeredPath !== repositoryPath || registeredGitCommonDir !== gitCommonDir) {
    workspaces.inspections = Array.from({ length: 3 }, () => ({
      canonicalRepositoryPath: registeredPath,
      canonicalGitCommonDir: registeredGitCommonDir,
    }));
  }
  return {
    database,
    workspaces,
    resolver: new HarnessSQLiteRootProjectResolverV2({ database, workspaces }),
  };
}

function request(overrides: Readonly<{
  repositoryId?: string;
  canonicalWorkingDirectory?: string;
  createdAt?: string;
}> = {}) {
  return {
    repositoryId: overrides.repositoryId ?? repositoryId,
    canonicalWorkingDirectory:
      overrides.canonicalWorkingDirectory ?? repositoryPath,
    createdAt: overrides.createdAt ?? at,
  };
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}

describe("HarnessSQLiteRootProjectResolverV2", () => {
  test("ensures one deterministic project and exact-verifies replay", async () => {
    const value = fixture();
    const projectId = deriveHarnessProjectIdV2(repositoryPath);
    try {
      const first = await value.resolver.resolveExactProject(request());
      const replay = await value.resolver.resolveExactProject(request({
        createdAt: later,
      }));
      expect(first).toEqual({
        repositoryId,
        projectId,
        canonicalWorkingDirectory: repositoryPath,
        canonicalGitCommonDir: gitCommonDir,
        sourceSha,
      });
      expect(replay).toEqual(first);
      expect(value.database.query(`
        SELECT project_id, canonical_repository_path,
          canonical_git_common_dir, display_name,
          created_at, updated_at
        FROM projects WHERE project_id = ?1
      `).get(projectId)).toEqual({
        project_id: projectId,
        canonical_repository_path: repositoryPath,
        canonical_git_common_dir: gitCommonDir,
        display_name: "oprte-root-project-resolver-v2",
        created_at: at,
        updated_at: at,
      });
      expect(value.database.query(
        "SELECT count(*) AS count FROM projects",
      ).get()).toEqual({ count: 1 });
      expect(value.workspaces.calls).toEqual([
        `inspect:${repositoryPath}`,
        `resolve:${repositoryPath}:HEAD`,
        `inspect:${repositoryPath}`,
        `inspect:${repositoryPath}`,
        `inspect:${repositoryPath}`,
        `resolve:${repositoryPath}:HEAD`,
        `inspect:${repositoryPath}`,
        `inspect:${repositoryPath}`,
      ]);
    } finally {
      value.database.close();
    }
  });

  test("accepts an exact existing project without rewriting its label", async () => {
    const value = fixture();
    const projectId = deriveHarnessProjectIdV2(repositoryPath);
    try {
      value.database.query(`
        INSERT INTO projects (
          project_id, canonical_repository_path, canonical_git_common_dir,
          display_name, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'User label', ?4, ?4)
      `).run(projectId, repositoryPath, gitCommonDir, at);
      await value.resolver.resolveExactProject(request({ createdAt: later }));
      expect(value.database.query(`
        SELECT display_name, created_at, updated_at
        FROM projects WHERE project_id = ?1
      `).get(projectId)).toEqual({
        display_name: "User label",
        created_at: at,
        updated_at: at,
      });
    } finally {
      value.database.close();
    }
  });

  test("fails closed on deterministic ID, path, and Git identity conflicts", async () => {
    const cases = [
      {
        projectId: deriveHarnessProjectIdV2(repositoryPath),
        path: "/tmp/another-root-project",
        git: "/tmp/another-root-project/.git",
      },
      {
        projectId: "legacy-project-id-for-the-same-path",
        path: repositoryPath,
        git: gitCommonDir,
      },
      {
        projectId: deriveHarnessProjectIdV2(repositoryPath),
        path: repositoryPath,
        git: `${repositoryPath}/other.git`,
      },
      {
        projectId: "legacy-project-id-for-the-same-git-identity",
        path: "/tmp/another-worktree-for-the-same-git-identity",
        git: gitCommonDir,
      },
    ] as const;
    for (const conflicting of cases) {
      const value = fixture();
      try {
        value.database.query(`
          INSERT INTO projects (
            project_id, canonical_repository_path, canonical_git_common_dir,
            display_name, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'Conflict', ?4, ?4)
        `).run(
          conflicting.projectId,
          conflicting.path,
          conflicting.git,
          at,
        );
        expect(await captureRejection(
          value.resolver.resolveExactProject(request()),
        )).toMatchObject({ code: "identity_conflict" });
        expect(value.database.query(
          "SELECT count(*) AS count FROM projects",
        ).get()).toEqual({ count: 1 });
      } finally {
        value.database.close();
      }
    }
  });

  test("rejects registration drift and repository replacement before ensure", async () => {
    const mismatchedRegistration = fixture();
    try {
      expect(await captureRejection(
        mismatchedRegistration.resolver.resolveExactProject({
          ...request(),
          repositoryId: `repo_${"2".repeat(26)}`,
        }),
      )).toMatchObject({ code: "identity_conflict" });
      expect(mismatchedRegistration.database.query(
        "SELECT count(*) AS count FROM projects",
      ).get()).toEqual({ count: 0 });
      expect(mismatchedRegistration.workspaces.calls).toEqual([
        `inspect:${repositoryPath}`,
      ]);
    } finally {
      mismatchedRegistration.database.close();
    }

    const replaced = fixture();
    replaced.workspaces.inspections = [
      {
        canonicalRepositoryPath: repositoryPath,
        canonicalGitCommonDir: gitCommonDir,
      },
      {
        canonicalRepositoryPath: repositoryPath,
        canonicalGitCommonDir: `${repositoryPath}/replacement.git`,
      },
    ];
    try {
      expect(await captureRejection(
        replaced.resolver.resolveExactProject(request()),
      )).toMatchObject({ code: "identity_conflict" });
      expect(replaced.database.query(
        "SELECT count(*) AS count FROM projects",
      ).get()).toEqual({ count: 0 });
    } finally {
      replaced.database.close();
    }
  });

  test("wraps malformed dependency values without admitting an identity", async () => {
    const value = fixture();
    value.workspaces.resolvedSha = "not-a-source-sha";
    try {
      const error = await captureRejection(
        value.resolver.resolveExactProject(request()),
      );
      expect(error).toBeInstanceOf(HarnessRootProjectResolverV2Error);
      expect(error).toMatchObject({ code: "corrupt_dependency" });
      expect(value.database.query(
        "SELECT count(*) AS count FROM projects",
      ).get()).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });
});

test("project IDs are a canonical-path function", () => {
  assertProperty(fc.property(
    fc.stringMatching(/^[a-z][a-z0-9_-]{0,48}$/u),
    (component) => {
      const path = `/tmp/${component}`;
      const expected = `proj_${createHash("sha256")
        .update(path, "utf8")
        .digest("hex")
        .slice(0, 24)}`;
      expect(deriveHarnessProjectIdV2(path)).toBe(expected);
      expect(deriveHarnessProjectIdV2(path)).toBe(
        deriveHarnessProjectIdV2(path),
      );
      expect(() => deriveHarnessProjectIdV2(`/tmp/./${component}`))
        .toThrow();
    },
  ));
});
