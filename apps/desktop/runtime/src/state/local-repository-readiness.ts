import type { WorkspaceBroker } from "../workspaces/workspace-broker";

export interface LocalRepositoryProbeCandidate {
  readonly repositoryId: string;
  readonly canonicalRepositoryPath: string;
  readonly canonicalGitCommonDir: string;
}

export interface LocalRepositoryReadinessStore {
  workspaceRepositoryProbeCandidates(
    workspaceId: string,
  ): readonly LocalRepositoryProbeCandidate[];
}

const maximumConcurrentRepositoryProbes = 4;

/**
 * Revalidates private repository paths at the runtime edge. Registration in
 * SQLite is not readiness: the path must still resolve to the exact root of a
 * Git worktree under the bundled Git environment on every projection read.
 */
export class LocalRepositoryReadiness {
  readonly #inspector: Pick<WorkspaceBroker, "inspectRepository">;
  readonly #store: LocalRepositoryReadinessStore;

  constructor(options: {
    readonly inspector: Pick<WorkspaceBroker, "inspectRepository">;
    readonly store: LocalRepositoryReadinessStore;
  }) {
    this.#inspector = options.inspector;
    this.#store = options.store;
  }

  async readyRepositoryIds(workspaceId: string): Promise<ReadonlySet<string>> {
    const candidates = this.#store.workspaceRepositoryProbeCandidates(workspaceId);
    const ready = new Set<string>();
    let next = 0;
    const probe = async (): Promise<void> => {
      while (next < candidates.length) {
        const candidate = candidates[next];
        next += 1;
        if (candidate === undefined) continue;
        try {
          const inspected = await this.#inspector.inspectRepository(
            candidate.canonicalRepositoryPath,
          );
          if (
            inspected.canonicalRepositoryPath ===
              candidate.canonicalRepositoryPath
            && inspected.canonicalGitCommonDir ===
              candidate.canonicalGitCommonDir
          ) {
            ready.add(candidate.repositoryId);
          }
        } catch {
          // Missing, moved, and non-Git paths fail closed without disclosing
          // their private path through the renderer-facing projection.
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            maximumConcurrentRepositoryProbes,
            candidates.length,
          ),
        },
        () => probe(),
      ),
    );
    return ready;
  }
}
