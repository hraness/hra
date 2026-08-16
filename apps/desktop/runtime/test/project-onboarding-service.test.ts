import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../src/state/database";
import { LocalTaskStore } from "../src/state/local-task-store";
import type { GitResult, GitRunner } from "../src/workspaces/git-runner";
import { GitCommandError, requireGit } from "../src/workspaces/git-runner";
import {
  LocalTaskStoreProjectOnboardingAdapter,
  ProjectOnboardingService,
  type ProjectOnboardingIdentifierFactory,
  type ProjectOnboardingPersistencePort,
} from "../src/workspaces/onboarding-service";
import { WorkspaceBroker } from "../src/workspaces/workspace-broker";

const installationId = "install_onboarding_fixture";
const gitBinary = Bun.which("git");
const temporaryRoots: string[] = [];
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

class TestGitRunner implements GitRunner {
  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    if (gitBinary === null) throw new Error("Git is unavailable");
    const child = Bun.spawn([gitBinary, ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

class SequencedIdentifiers implements ProjectOnboardingIdentifierFactory {
  attempts = 0;
  #current = 0;

  repositoryId(): string {
    this.#current = this.attempts + 1;
    this.attempts += 1;
    return `repo_${locator(this.#current)}`;
  }

  workspaceId(): string {
    return `wsp_${locator(this.#current + 100)}`;
  }

  builtinAgentId(): string {
    return `agent_local_${String(this.#current)}`;
  }

  taskKeyPrefix(): string {
    return `K${String(this.#current).padStart(2, "0")}`;
  }
}

async function repositoryFixture(prefix: string): Promise<{
  readonly broker: WorkspaceBroker;
  readonly git: TestGitRunner;
  readonly repository: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  const git = new TestGitRunner();
  await requireGit(git, repository, ["init", "--initial-branch=main"]);
  await requireGit(git, repository, ["config", "user.name", "OPRTE test"]);
  await requireGit(git, repository, ["config", "user.email", "test@oprte.invalid"]);
  await writeFile(join(repository, "fixture.txt"), "fixture\n");
  await requireGit(git, repository, ["add", "fixture.txt"]);
  await requireGit(git, repository, ["commit", "-m", "fixture"]);
  return {
    root,
    repository,
    git,
    broker: new WorkspaceBroker({
      git,
      lanesRoot: join(root, "managed-lanes"),
    }),
  };
}

function localPersistenceFixture(): {
  readonly database: Database;
  readonly persistence: LocalTaskStoreProjectOnboardingAdapter;
} {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const store = new LocalTaskStore(database, new Uint8Array(32).fill(0x51));
  store.registerInstallation(installationId, 1);
  return {
    database,
    persistence: new LocalTaskStoreProjectOnboardingAdapter(store),
  };
}

function service(
  broker: WorkspaceBroker,
  persistence: ProjectOnboardingPersistencePort,
  identifiers: ProjectOnboardingIdentifierFactory = new SequencedIdentifiers(),
  maximumIdentifierAttempts = 8,
): ProjectOnboardingService {
  return new ProjectOnboardingService({
    repositories: broker,
    persistence,
    identifiers,
    now: () => 100,
    maximumIdentifierAttempts,
  });
}

function zeroCounts() {
  const zero = { capped: false, value: 0 } as const;
  return {
    all: zero,
    ready: zero,
    blocked: zero,
    deferred: zero,
    attention: zero,
    assigned: zero,
    review: zero,
  };
}

function locator(value: number): string {
  let remaining = value;
  let encoded = "";
  do {
    encoded = (crockford[remaining % crockford.length] ?? "0") + encoded;
    remaining = Math.floor(remaining / crockford.length);
  } while (remaining > 0);
  return encoded.padStart(26, "0");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(gitBinary === null)("project onboarding service", () => {
  test("onboards a repository root atomically with optional remote metadata", async () => {
    const { broker, repository, root } = await repositoryFixture(
      "oprte-onboard-root-",
    );
    const { database, persistence } = localPersistenceFixture();
    try {
      const outcome = await service(broker, persistence).onboard({
        trustedDirectoryPath: repository,
        installationId,
        provider: "github",
        publicUrl: "https://github.com/example/oprte",
      });

      expect(outcome.ok).toBeTrue();
      if (!outcome.ok) throw new Error("Expected onboarding to succeed");
      expect(outcome.value.repository.name).toBe("repository");
      expect(outcome.value.workspace.authority).toEqual({
        kind: "local",
        localWorkspaceId: outcome.value.workspace.id,
        ownerInstallationId: installationId,
      });
      expect(
        database.query<{ provider: string; public_url: string }, []>(`
          SELECT provider, public_url FROM local_repositories
        `).get(),
      ).toEqual({
        provider: "github",
        public_url: "https://github.com/example/oprte",
      });
      const serialized = JSON.stringify(outcome);
      expect(serialized.includes(root)).toBeFalse();
      expect(serialized.includes(".git")).toBeFalse();
    } finally {
      database.close();
    }
  });

  test("rejects nested directories and selected symlink aliases", async () => {
    const { broker, repository, root } = await repositoryFixture(
      "oprte-onboard-paths-",
    );
    const nested = join(repository, "nested");
    const alias = join(root, "repository-alias");
    await mkdir(nested);
    await symlink(repository, alias, "dir");
    const { database, persistence } = localPersistenceFixture();
    try {
      const onboarding = service(broker, persistence);
      expect(await onboarding.onboard({
        trustedDirectoryPath: nested,
        installationId,
      })).toEqual({
        ok: false,
        error: {
          code: "invalid_repository",
          message: "The selected folder is not an eligible Git repository.",
        },
      });
      expect(await onboarding.onboard({
        trustedDirectoryPath: alias,
        installationId,
      })).toEqual({
        ok: false,
        error: {
          code: "invalid_repository",
          message: "The selected folder is not an eligible Git repository.",
        },
      });
    } finally {
      database.close();
    }
  });

  test("accepts a linked-worktree root when it is the first local binding", async () => {
    const { broker, git, repository, root } = await repositoryFixture(
      "oprte-onboard-linked-",
    );
    const linked = join(root, "linked-worktree");
    await requireGit(git, repository, ["worktree", "add", "-b", "linked-test", linked]);
    const { database, persistence } = localPersistenceFixture();
    try {
      const outcome = await service(broker, persistence).onboard({
        trustedDirectoryPath: linked,
        installationId,
      });
      expect(outcome.ok).toBeTrue();
      expect(JSON.stringify(outcome).includes(root)).toBeFalse();
    } finally {
      database.close();
    }
  });

  test("returns the canonical durable identity when fresh candidates drift", async () => {
    const { broker, repository } = await repositoryFixture(
      "oprte-onboard-idempotent-",
    );
    const { database, persistence } = localPersistenceFixture();
    const identifiers = new SequencedIdentifiers();
    try {
      const onboarding = service(broker, persistence, identifiers);
      const first = await onboarding.onboard({
        trustedDirectoryPath: repository,
        installationId,
      });
      const replay = await onboarding.onboard({
        trustedDirectoryPath: repository,
        installationId,
        repositoryName: "A candidate name that must not replace the durable one",
      });

      expect(replay).toEqual(first);
      expect(identifiers.attempts).toBe(2);
      expect(
        database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM local_repositories",
        ).get()?.count,
      ).toBe(1);
      expect(
        database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM local_workspaces",
        ).get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  test("retries bounded candidate collisions and returns the successful candidate", async () => {
    const { broker, repository } = await repositoryFixture(
      "oprte-onboard-collision-",
    );
    const identifiers = new SequencedIdentifiers();
    let calls = 0;
    const persistence: ProjectOnboardingPersistencePort = {
      onboardProject(input) {
        calls += 1;
        if (calls < 3) return { kind: "identifier_collision" };
        return {
          kind: "stored",
          value: {
            repository: {
              id: input.repository.repositoryId,
              name: input.repository.name,
              createdAt: 100,
            },
            workspace: {
              id: input.workspace.workspaceId,
              name: input.workspace.name,
              slug: input.workspace.slug,
              keyPrefix: input.workspace.keyPrefix,
              revision: 1,
              authority: {
                kind: "local",
                localWorkspaceId: input.workspace.workspaceId,
                ownerInstallationId: input.installationId,
              },
              counts: zeroCounts(),
            },
          },
        };
      },
    };

    const outcome = await service(broker, persistence, identifiers, 3).onboard({
      trustedDirectoryPath: repository,
      installationId,
    });

    expect(outcome.ok).toBeTrue();
    if (!outcome.ok) throw new Error("Expected collision retry to succeed");
    expect(calls).toBe(3);
    expect(outcome.value.repository.id).toBe(`repo_${locator(3)}`);
    expect(outcome.value.workspace.keyPrefix).toBe("K03");
  });

  test("fails safely after the configured collision budget", async () => {
    const { broker, repository } = await repositoryFixture(
      "oprte-onboard-exhaustion-",
    );
    let calls = 0;
    const persistence: ProjectOnboardingPersistencePort = {
      onboardProject() {
        calls += 1;
        return { kind: "identifier_collision" };
      },
    };

    const outcome = await service(
      broker,
      persistence,
      new SequencedIdentifiers(),
      3,
    ).onboard({
      trustedDirectoryPath: repository,
      installationId,
    });

    expect(calls).toBe(3);
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "identifier_exhausted",
        message: "Local identifiers could not be allocated.",
      },
    });
  });

  test("fails closed when only one side of the canonical Git identity matches", async () => {
    const { broker, git, repository, root } = await repositoryFixture(
      "oprte-onboard-conflict-",
    );
    const linked = join(root, "conflicting-worktree");
    await requireGit(git, repository, ["worktree", "add", "-b", "conflict-test", linked]);
    const { database, persistence } = localPersistenceFixture();
    try {
      const onboarding = service(broker, persistence);
      expect((await onboarding.onboard({
        trustedDirectoryPath: repository,
        installationId,
      })).ok).toBeTrue();

      expect(await onboarding.onboard({
        trustedDirectoryPath: linked,
        installationId,
      })).toEqual({
        ok: false,
        error: {
          code: "identity_conflict",
          message: "The repository conflicts with existing local data.",
        },
      });
    } finally {
      database.close();
    }
  });

  test("redacts selected paths, Git stderr, and common-dir details from failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-onboard-redaction-"));
    temporaryRoots.push(root);
    const secretPath = join(root, "private-repository");
    const secretCommonDir = join(root, "private-common-dir");
    const secretStderr = "fatal: credential helper emitted private diagnostics";
    await mkdir(secretPath);
    let persistenceCalls = 0;
    const onboarding = new ProjectOnboardingService({
      repositories: {
        inspectRepository: () => Promise.reject(
          new GitCommandError(["rev-parse", secretCommonDir], {
            exitCode: 128,
            stdout: "",
            stderr: secretStderr,
          }),
        ),
      },
      persistence: {
        onboardProject() {
          persistenceCalls += 1;
          return { kind: "failed" };
        },
      },
    });

    const outcome = await onboarding.onboard({
      trustedDirectoryPath: secretPath,
      installationId,
    });
    const serialized = JSON.stringify(outcome);

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "invalid_repository",
        message: "The selected folder is not an eligible Git repository.",
      },
    });
    expect(persistenceCalls).toBe(0);
    expect(serialized.includes(secretPath)).toBeFalse();
    expect(serialized.includes(secretCommonDir)).toBeFalse();
    expect(serialized.includes(secretStderr)).toBeFalse();
  });

  test("rejects untrusted relative input before repository inspection", async () => {
    let inspected = false;
    const persistence: ProjectOnboardingPersistencePort = {
      onboardProject() {
        return { kind: "failed" };
      },
    };
    const onboarding = new ProjectOnboardingService({
      repositories: {
        inspectRepository: () => {
          inspected = true;
          return Promise.reject(new Error("must not inspect"));
        },
      },
      persistence,
    });

    expect(await onboarding.onboard({
      trustedDirectoryPath: "relative/repository",
      installationId,
    })).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "The onboarding request is invalid.",
      },
    });
    expect(inspected).toBeFalse();
  });
});
