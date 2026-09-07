import { projectIdSchema, type ProjectId } from "../domain/values.ts";

/**
 * One process-local serialization owner for every operation that can observe
 * or advance a project's canonical memory authority. Memory tools and hosted
 * synchronization share this instance; network I/O must happen outside it.
 */
export class ProjectMemorySerialExecutor {
  readonly #tails = new Map<ProjectId, Promise<unknown>>();

  run<T>(projectIdValue: string, operation: () => Promise<T>): Promise<T> {
    const projectId = projectIdSchema.parse(projectIdValue);
    const prior = this.#tails.get(projectId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.#tails.set(projectId, current);
    return current.finally(() => {
      if (this.#tails.get(projectId) === current) this.#tails.delete(projectId);
    });
  }

  async drain(): Promise<void> {
    for (;;) {
      const pending = [...this.#tails.values()];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }
}
