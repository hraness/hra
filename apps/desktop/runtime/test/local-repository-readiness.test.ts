import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../src/state/database";
import { LocalRepositoryReadiness } from "../src/state/local-repository-readiness";
import { LocalTaskStore } from "../src/state/local-task-store";
import {
  requireGit,
  type GitResult,
  type GitRunner,
} from "../src/workspaces/git-runner";
import { WorkspaceBroker } from "../src/workspaces/workspace-broker";

const temporaryRoots: string[] = [];
const gitBinary = Bun.which("git");

function publicId(prefix: string, value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = value;
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[remaining % 32] ?? "0") + locator;
    remaining = Math.floor(remaining / 32);
  }
  return `${prefix}_${locator}`;
}

class TestGitRunner implements GitRunner {
  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    if (gitBinary === null) throw new Error("Git is unavailable");
    const child = Bun.spawn([gitBinary, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(gitBinary === null)("local repository readiness", () => {
  test("fails closed after a registered Git root is deleted or replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-local-readiness-"));
    temporaryRoots.push(root);
    const repositoryPath = join(root, "repository");
    const lanesRoot = join(root, "lanes");
    await mkdir(repositoryPath);
    const git = new TestGitRunner();
    await requireGit(git, repositoryPath, ["init", "--initial-branch=main"]);
    const inspector = new WorkspaceBroker({ git, lanesRoot });
    const identity = await inspector.inspectRepository(repositoryPath);

    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    try {
      const tasks = new LocalTaskStore(
        database,
        new Uint8Array(32).fill(0x6a),
      );
      const installationId = "install_repository_readiness";
      const workspaceId = publicId("wsp", 178);
      const repositoryId = publicId("repo", 178);
      tasks.registerInstallation(installationId, 1);
      tasks.onboardProject({
        installationId,
        repository: {
          repositoryId,
          name: "Readiness fixture",
          canonicalRepositoryPath: identity.canonicalRepositoryPath,
          canonicalGitCommonDir: identity.canonicalGitCommonDir,
        },
        workspace: {
          workspaceId,
          name: "Readiness workspace",
          slug: "readiness-workspace",
          keyPrefix: "RD",
        },
      }, 2);
      const initial = new LocalRepositoryReadiness({
        inspector,
        store: tasks,
      });
      const ready = await initial.readyRepositoryIds(workspaceId);
      expect([...ready]).toEqual([repositoryId]);
      expect(tasks.listWorkspaceRepositories(workspaceId, ready).repositories)
        .toEqual([{
          id: repositoryId,
          name: "Readiness fixture",
          ready: true,
        }]);

      database.query(`
        UPDATE local_repositories
        SET canonical_git_common_dir = ?2
        WHERE repository_id = ?1
      `).run(repositoryId, join(root, "different-common-dir"));
      const afterIdentityMismatch = await initial.readyRepositoryIds(workspaceId);
      expect([...afterIdentityMismatch]).toEqual([]);
      database.query(`
        UPDATE local_repositories
        SET canonical_git_common_dir = ?2
        WHERE repository_id = ?1
      `).run(repositoryId, identity.canonicalGitCommonDir);

      await rm(repositoryPath, { recursive: true });
      const afterDeletion = await new LocalRepositoryReadiness({
        inspector: new WorkspaceBroker({ git, lanesRoot }),
        store: tasks,
      }).readyRepositoryIds(workspaceId);
      expect([...afterDeletion]).toEqual([]);
      expect(tasks.listWorkspaceRepositories(
        workspaceId,
        afterDeletion,
      ).repositories[0]?.ready).toBeFalse();

      await mkdir(repositoryPath);
      const afterNonGitReplacement = await new LocalRepositoryReadiness({
        inspector: new WorkspaceBroker({ git, lanesRoot }),
        store: tasks,
      }).readyRepositoryIds(workspaceId);
      const projection = tasks.listWorkspaceRepositories(
        workspaceId,
        afterNonGitReplacement,
      );
      expect([...afterNonGitReplacement]).toEqual([]);
      expect(projection.repositories[0]?.ready).toBeFalse();
      expect(JSON.stringify(projection)).not.toContain(repositoryPath);
    } finally {
      database.close();
    }
  });
});
