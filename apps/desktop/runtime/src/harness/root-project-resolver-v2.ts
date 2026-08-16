import { basename, isAbsolute, resolve } from "node:path";

import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

import type { WorkspaceBroker } from "../workspaces/workspace-broker";
import { deriveSessionProjectIdForCanonicalPath } from
  "./root-actor-authority-v2";

const canonicalPathSchema = z.string().min(1).max(4_096).refine(
  (value) =>
    isAbsolute(value) && resolve(value) === value && !value.includes("\0"),
  "repository paths must be absolute, canonical, and NUL-free",
);
const repositoryIdSchema = z.string().min(1).max(128).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "repository identity must be trimmed and NUL-free",
);
const sourceShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);

const inputSchema = z.object({
  repositoryId: repositoryIdSchema,
  canonicalWorkingDirectory: canonicalPathSchema,
  createdAt: timestampSchema,
}).strict();

const inspectedRepositorySchema = z.object({
  canonicalRepositoryPath: canonicalPathSchema,
  canonicalGitCommonDir: canonicalPathSchema,
}).strict();

const registeredRepositoryRowSchema = z.object({
  repository_id: repositoryIdSchema,
  canonical_repository_path: canonicalPathSchema,
  canonical_git_common_dir: canonicalPathSchema,
  tombstoned_at: z.number().int().nonnegative().nullable(),
}).strict();

const projectRowSchema = z.object({
  // Read legacy or conflicting IDs as data so they can be classified as an
  // identity conflict instead of being hidden behind a row-parse failure.
  project_id: repositoryIdSchema,
  canonical_repository_path: canonicalPathSchema,
  canonical_git_common_dir: canonicalPathSchema,
}).strict();

export interface HarnessRootProjectResolutionV2 {
  readonly repositoryId: string;
  readonly projectId: string;
  readonly canonicalWorkingDirectory: string;
  readonly canonicalGitCommonDir: string;
  readonly sourceSha: string;
}

export interface HarnessRootProjectResolverPortV2 {
  resolveExactProject(input: Readonly<{
    repositoryId: string;
    canonicalWorkingDirectory: string;
    createdAt: string;
  }>): Promise<unknown>;
}

export class HarnessRootProjectResolverV2Error extends Error {
  readonly code: "corrupt_dependency" | "identity_conflict";

  constructor(
    code: HarnessRootProjectResolverV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRootProjectResolverV2Error";
    this.code = code;
  }
}

/**
 * Resolves one renderer repository identity to the deterministic project row
 * used by the actor graph. The public `repo_*` identity is only a lookup fence;
 * it never enters actor persistence. Repository inspection is repeated around
 * HEAD resolution and the database ensure so path replacement fails closed
 * before root preparation or provider work can begin.
 */
export class HarnessSQLiteRootProjectResolverV2
implements HarnessRootProjectResolverPortV2 {
  readonly #database: Database;
  readonly #workspaces: Pick<
    WorkspaceBroker,
    "inspectRepository" | "resolveBase"
  >;

  constructor(options: Readonly<{
    database: Database;
    workspaces: Pick<WorkspaceBroker, "inspectRepository" | "resolveBase">;
  }>) {
    this.#database = options.database;
    this.#workspaces = options.workspaces;
  }

  async resolveExactProject(
    inputValue: Readonly<{
      repositoryId: string;
      canonicalWorkingDirectory: string;
      createdAt: string;
    }>,
  ): Promise<HarnessRootProjectResolutionV2> {
    try {
      const input = inputSchema.parse(inputValue);
      const before = inspectedRepositorySchema.parse(
        await this.#workspaces.inspectRepository(
          input.canonicalWorkingDirectory,
        ),
      );
      this.#assertInspectedPath(input.canonicalWorkingDirectory, before);
      this.#assertRegisteredRepository(input.repositoryId, before);

      const sourceSha = sourceShaSchema.parse(
        await this.#workspaces.resolveBase(
          before.canonicalRepositoryPath,
          "HEAD",
        ),
      );
      const after = inspectedRepositorySchema.parse(
        await this.#workspaces.inspectRepository(
          input.canonicalWorkingDirectory,
        ),
      );
      this.#assertSameInspection(before, after);
      this.#assertRegisteredRepository(input.repositoryId, after);

      const projectId = deriveHarnessProjectIdV2(
        after.canonicalRepositoryPath,
      );
      this.#ensureExactProject({
        projectId,
        canonicalRepositoryPath: after.canonicalRepositoryPath,
        canonicalGitCommonDir: after.canonicalGitCommonDir,
        createdAt: input.createdAt,
      });

      // The project ensure is a database effect. Reinspect once afterward so
      // callers cannot begin root effects using a repository replaced during
      // that transaction.
      const settled = inspectedRepositorySchema.parse(
        await this.#workspaces.inspectRepository(
          input.canonicalWorkingDirectory,
        ),
      );
      this.#assertSameInspection(after, settled);
      this.#assertRegisteredRepository(input.repositoryId, settled);
      this.#assertExactProject({
        projectId,
        canonicalRepositoryPath: settled.canonicalRepositoryPath,
        canonicalGitCommonDir: settled.canonicalGitCommonDir,
      });

      return Object.freeze({
        repositoryId: input.repositoryId,
        projectId,
        canonicalWorkingDirectory: settled.canonicalRepositoryPath,
        canonicalGitCommonDir: settled.canonicalGitCommonDir,
        sourceSha,
      });
    } catch (cause: unknown) {
      if (cause instanceof HarnessRootProjectResolverV2Error) throw cause;
      throw new HarnessRootProjectResolverV2Error(
        "corrupt_dependency",
        "root project resolution failed",
        cause,
      );
    }
  }

  #assertInspectedPath(
    requestedPath: string,
    inspected: z.infer<typeof inspectedRepositorySchema>,
  ): void {
    if (inspected.canonicalRepositoryPath !== requestedPath) {
      conflict("workspace inspection resolved another repository path");
    }
  }

  #assertSameInspection(
    expected: z.infer<typeof inspectedRepositorySchema>,
    actual: z.infer<typeof inspectedRepositorySchema>,
  ): void {
    if (
      actual.canonicalRepositoryPath !== expected.canonicalRepositoryPath ||
      actual.canonicalGitCommonDir !== expected.canonicalGitCommonDir
    ) {
      conflict("repository identity changed during project resolution");
    }
  }

  #assertRegisteredRepository(
    repositoryId: string,
    inspected: z.infer<typeof inspectedRepositorySchema>,
  ): void {
    const rows = z.array(registeredRepositoryRowSchema).max(3).parse(
      this.#database.query(`
        SELECT repository_id, canonical_repository_path,
          canonical_git_common_dir, tombstoned_at
        FROM local_repositories
        WHERE repository_id = ?1
          OR canonical_repository_path = ?2
          OR canonical_git_common_dir = ?3
        ORDER BY repository_id
        LIMIT 3
      `).all(
        repositoryId,
        inspected.canonicalRepositoryPath,
        inspected.canonicalGitCommonDir,
      ),
    );
    const row = rows[0];
    if (
      rows.length !== 1 || row === undefined ||
      row.repository_id !== repositoryId ||
      row.canonical_repository_path !== inspected.canonicalRepositoryPath ||
      row.canonical_git_common_dir !== inspected.canonicalGitCommonDir ||
      row.tombstoned_at !== null
    ) {
      conflict("registered repository identity does not match inspection");
    }
  }

  #ensureExactProject(input: Readonly<{
    projectId: string;
    canonicalRepositoryPath: string;
    canonicalGitCommonDir: string;
    createdAt: string;
  }>): void {
    this.#database.transaction(() => {
      const existing = this.#readProjectCandidates(
        input.projectId,
        input.canonicalRepositoryPath,
        input.canonicalGitCommonDir,
      );
      if (existing.length === 0) {
        const displayName = basename(input.canonicalRepositoryPath);
        if (displayName.length < 1) {
          conflict("canonical repository path has no display name");
        }
        this.#database.query(`
          INSERT OR IGNORE INTO projects (
            project_id, canonical_repository_path,
            canonical_git_common_dir, display_name,
            created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        `).run(
          input.projectId,
          input.canonicalRepositoryPath,
          input.canonicalGitCommonDir,
          displayName,
          input.createdAt,
        );
      }
      this.#assertExactProject(input);
    }).immediate();
  }

  #assertExactProject(input: Readonly<{
    projectId: string;
    canonicalRepositoryPath: string;
    canonicalGitCommonDir: string;
  }>): void {
    const rows = this.#readProjectCandidates(
      input.projectId,
      input.canonicalRepositoryPath,
      input.canonicalGitCommonDir,
    );
    const row = rows[0];
    if (
      rows.length !== 1 || row === undefined ||
      row.project_id !== input.projectId ||
      row.canonical_repository_path !== input.canonicalRepositoryPath ||
      row.canonical_git_common_dir !== input.canonicalGitCommonDir
    ) {
      conflict("deterministic project identity conflicts with stored state");
    }
  }

  #readProjectCandidates(
    projectId: string,
    canonicalRepositoryPath: string,
    canonicalGitCommonDir: string,
  ): readonly z.infer<typeof projectRowSchema>[] {
    return z.array(projectRowSchema).max(2).parse(this.#database.query(`
      SELECT project_id, canonical_repository_path, canonical_git_common_dir
      FROM projects
      WHERE project_id = ?1
        OR canonical_repository_path = ?2
        OR canonical_git_common_dir = ?3
      ORDER BY project_id
      LIMIT 2
    `).all(projectId, canonicalRepositoryPath, canonicalGitCommonDir));
  }
}

export function deriveHarnessProjectIdV2(
  canonicalRepositoryPathValue: string,
): string {
  const canonicalRepositoryPath = canonicalPathSchema.parse(
    canonicalRepositoryPathValue,
  );
  return deriveSessionProjectIdForCanonicalPath(canonicalRepositoryPath);
}

function conflict(message: string): never {
  throw new HarnessRootProjectResolverV2Error("identity_conflict", message);
}
