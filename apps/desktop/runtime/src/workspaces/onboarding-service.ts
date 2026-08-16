import {
  taskDomain,
  workspaceSummarySchema,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import {
  LocalOnboardingConflict,
  LocalOnboardingIdentifierCollision,
  LocalTaskStoreError,
  type LocalProjectOnboardingResult,
  type LocalTaskStore,
} from "../state/local-task-store";
import type { InspectedRepository } from "./workspace-broker";

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const prefixAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const maximumDefaultIdentifierAttempts = 8;

const onboardingRequestSchema = z.object({
  trustedDirectoryPath: z.string().min(1).max(4_096)
    .refine((value) => !value.includes("\0"), "path contains a null byte")
    .refine(isAbsolute, "path must be absolute"),
  installationId: taskDomain.runnerInstallationIdSchema,
  repositoryName: taskDomain.repositoryNameSchema.optional(),
  workspaceName: taskDomain.workspaceNameSchema.optional(),
  provider: taskDomain.repositoryProviderSchema.optional(),
  publicUrl: taskDomain.absoluteHttpsUrlSchema.optional(),
}).strict();

const safeOnboardingResultSchema = z.object({
  repository: z.object({
    id: taskDomain.repositoryIdSchema,
    name: taskDomain.repositoryNameSchema,
    createdAt: taskDomain.epochMsSchema,
  }).strict(),
  workspace: workspaceSummarySchema,
}).strict();

export interface ProjectOnboardingPersistenceInput {
  readonly installationId: string;
  readonly repository: Readonly<{
    repositoryId: string;
    name: string;
    provider?: "github" | "gitlab" | "bitbucket" | "other" | undefined;
    publicUrl?: string | undefined;
    canonicalRepositoryPath: string;
    canonicalGitCommonDir: string;
  }>;
  readonly workspace: Readonly<{
    workspaceId: string;
    name: string;
    slug: string;
    keyPrefix: string;
    builtinAgentId: string;
  }>;
}

export type ProjectOnboardingPersistenceOutcome =
  | Readonly<{
      kind: "stored";
      value: LocalProjectOnboardingResult;
    }>
  | Readonly<{ kind: "identifier_collision" }>
  | Readonly<{ kind: "identity_conflict" }>
  | Readonly<{ kind: "installation_not_registered" }>
  | Readonly<{ kind: "failed" }>;

export interface ProjectOnboardingPersistencePort {
  onboardProject(
    input: ProjectOnboardingPersistenceInput,
    now: number,
  ): ProjectOnboardingPersistenceOutcome;
}

/**
 * Converts the exception-oriented atomic LocalTaskStore API into the narrow,
 * data-only result consumed by onboarding. Unknown persistence failures are
 * deliberately collapsed so SQLite details cannot cross the bridge.
 */
export class LocalTaskStoreProjectOnboardingAdapter
implements ProjectOnboardingPersistencePort {
  readonly #store: Pick<LocalTaskStore, "onboardProject">;

  constructor(store: Pick<LocalTaskStore, "onboardProject">) {
    this.#store = store;
  }

  onboardProject(
    input: ProjectOnboardingPersistenceInput,
    now: number,
  ): ProjectOnboardingPersistenceOutcome {
    try {
      return {
        kind: "stored",
        value: this.#store.onboardProject(input, now),
      };
    } catch (error: unknown) {
      if (error instanceof LocalOnboardingIdentifierCollision) {
        return { kind: "identifier_collision" };
      }
      if (error instanceof LocalOnboardingConflict) {
        return { kind: "identity_conflict" };
      }
      if (error instanceof LocalTaskStoreError && error.code === "not_found") {
        return { kind: "installation_not_registered" };
      }
      return { kind: "failed" };
    }
  }
}

export interface ProjectOnboardingRepositoryPort {
  inspectRepository(repositoryPath: string): Promise<InspectedRepository>;
}

export interface ProjectOnboardingIdentifierFactory {
  repositoryId(): string;
  workspaceId(): string;
  builtinAgentId(): string;
  taskKeyPrefix(): string;
}

export type ProjectOnboardingErrorCode =
  | "invalid_request"
  | "invalid_repository"
  | "identity_conflict"
  | "identifier_exhausted"
  | "installation_not_registered"
  | "persistence_failed";

export type ProjectOnboardingOutcome =
  | Readonly<{
      ok: true;
      value: Readonly<{
        repository: Readonly<{
          id: string;
          name: string;
          createdAt: number;
        }>;
        workspace: WorkspaceSummary;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: ProjectOnboardingErrorCode;
        message: string;
      }>;
    }>;

export interface ProjectOnboardingServiceOptions {
  readonly repositories: ProjectOnboardingRepositoryPort;
  readonly persistence: ProjectOnboardingPersistencePort;
  readonly identifiers?: ProjectOnboardingIdentifierFactory;
  readonly now?: () => number;
  readonly maximumIdentifierAttempts?: number;
}

export class ProjectOnboardingService {
  readonly #repositories: ProjectOnboardingRepositoryPort;
  readonly #persistence: ProjectOnboardingPersistencePort;
  readonly #identifiers: ProjectOnboardingIdentifierFactory;
  readonly #now: () => number;
  readonly #maximumIdentifierAttempts: number;

  constructor(options: ProjectOnboardingServiceOptions) {
    this.#repositories = options.repositories;
    this.#persistence = options.persistence;
    this.#identifiers = options.identifiers ?? randomOnboardingIdentifiers;
    this.#now = options.now ?? Date.now;
    this.#maximumIdentifierAttempts = z.number().int().min(1).max(32).parse(
      options.maximumIdentifierAttempts ?? maximumDefaultIdentifierAttempts,
    );
  }

  async onboard(inputValue: unknown): Promise<ProjectOnboardingOutcome> {
    const request = onboardingRequestSchema.safeParse(inputValue);
    if (!request.success) return onboardingError("invalid_request");

    const selectedPath = resolve(request.data.trustedDirectoryPath);
    try {
      const selected = await lstat(selectedPath);
      if (!selected.isDirectory() || selected.isSymbolicLink()) {
        return onboardingError("invalid_repository");
      }
    } catch {
      return onboardingError("invalid_repository");
    }

    let inspected: InspectedRepository;
    try {
      inspected = await this.#repositories.inspectRepository(selectedPath);
    } catch {
      return onboardingError("invalid_repository");
    }

    const repositoryName = taskDomain.repositoryNameSchema.safeParse(
      request.data.repositoryName ?? basename(inspected.canonicalRepositoryPath),
    );
    const workspaceName = taskDomain.workspaceNameSchema.safeParse(
      request.data.workspaceName ??
        request.data.repositoryName ??
        basename(inspected.canonicalRepositoryPath),
    );
    if (!repositoryName.success || !workspaceName.success) {
      return onboardingError("invalid_request");
    }

    const now = taskDomain.epochMsSchema.safeParse(this.#now());
    if (!now.success) return onboardingError("persistence_failed");

    for (
      let attempt = 0;
      attempt < this.#maximumIdentifierAttempts;
      attempt += 1
    ) {
      const candidate = this.#candidate();
      if (candidate === null) continue;
      const repository = {
        repositoryId: candidate.repositoryId,
        name: repositoryName.data,
        canonicalRepositoryPath: inspected.canonicalRepositoryPath,
        canonicalGitCommonDir: inspected.canonicalGitCommonDir,
        ...(request.data.provider === undefined
          ? {}
          : { provider: request.data.provider }),
        ...(request.data.publicUrl === undefined
          ? {}
          : { publicUrl: request.data.publicUrl }),
      };
      let stored: ProjectOnboardingPersistenceOutcome;
      try {
        stored = this.#persistence.onboardProject({
          installationId: request.data.installationId,
          repository,
          workspace: {
            workspaceId: candidate.workspaceId,
            name: workspaceName.data,
            slug: candidate.slug,
            keyPrefix: candidate.taskKeyPrefix,
            builtinAgentId: candidate.builtinAgentId,
          },
        }, now.data);
      } catch {
        return onboardingError("persistence_failed");
      }
      switch (stored.kind) {
        case "stored": {
          const safe = safeOnboardingResultSchema.safeParse(stored.value);
          return safe.success
            ? { ok: true, value: safe.data }
            : onboardingError("persistence_failed");
        }
        case "identifier_collision":
          continue;
        case "identity_conflict":
          return onboardingError("identity_conflict");
        case "installation_not_registered":
          return onboardingError("installation_not_registered");
        case "failed":
          return onboardingError("persistence_failed");
      }
    }
    return onboardingError("identifier_exhausted");
  }

  #candidate(): Readonly<{
    repositoryId: string;
    workspaceId: string;
    builtinAgentId: string;
    taskKeyPrefix: string;
    slug: string;
  }> | null {
    let raw: Readonly<{
      repositoryId: string;
      workspaceId: string;
      builtinAgentId: string;
      taskKeyPrefix: string;
    }>;
    try {
      raw = {
        repositoryId: this.#identifiers.repositoryId(),
        workspaceId: this.#identifiers.workspaceId(),
        builtinAgentId: this.#identifiers.builtinAgentId(),
        taskKeyPrefix: this.#identifiers.taskKeyPrefix(),
      };
    } catch {
      return null;
    }
    const parsed = z.object({
      repositoryId: taskDomain.repositoryIdSchema,
      workspaceId: taskDomain.workspacePublicIdSchema,
      builtinAgentId: taskDomain.agentIdSchema,
      taskKeyPrefix: taskDomain.taskKeyPrefixSchema,
    }).strict().safeParse(raw);
    if (!parsed.success) return null;
    const slug = taskDomain.workspaceSlugSchema.safeParse(
      `local-${parsed.data.workspaceId.slice(4).toLowerCase()}`,
    );
    return slug.success ? { ...parsed.data, slug: slug.data } : null;
  }
}

export const randomOnboardingIdentifiers: ProjectOnboardingIdentifierFactory = {
  repositoryId: () => `repo_${randomCrockfordLocator()}`,
  workspaceId: () => `wsp_${randomCrockfordLocator()}`,
  builtinAgentId: () => `agent_local_${randomCrockfordLocator().toLowerCase()}`,
  taskKeyPrefix: () => {
    const bytes = randomBytes(4);
    const first = prefixAlphabet[(bytes[0] ?? 0) % prefixAlphabet.length] ?? "K";
    return `${first}${[...bytes.subarray(1)]
      .map((byte) => crockfordAlphabet[byte % crockfordAlphabet.length] ?? "0")
      .join("")}`;
  },
};

function randomCrockfordLocator(): string {
  return [...randomBytes(26)]
    .map((byte) => crockfordAlphabet[byte % crockfordAlphabet.length] ?? "0")
    .join("");
}

function onboardingError(code: ProjectOnboardingErrorCode):
  Extract<ProjectOnboardingOutcome, { ok: false }> {
  const messages: Record<ProjectOnboardingErrorCode, string> = {
    invalid_request: "The onboarding request is invalid.",
    invalid_repository: "The selected folder is not an eligible Git repository.",
    identity_conflict: "The repository conflicts with existing local data.",
    identifier_exhausted: "Local identifiers could not be allocated.",
    installation_not_registered: "The local installation is not registered.",
    persistence_failed: "The project could not be saved locally.",
  };
  return { ok: false, error: { code, message: messages[code] } };
}
