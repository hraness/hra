import { z } from "@hra-internal/schema";

import { actorIdSchema } from "./actor-domain";
import {
  harnessProjectionReconciliationPageLimit,
  type HarnessProjectionWitnessV2,
} from "./renderer-sqlite-adapter-v2";

const DEFAULT_PAGE_SIZE = 64;
const DEFAULT_MAX_ACTORS = 4_096;
const MAX_ACTOR_SCAN = 16_384;

const revisionSchema = z.number().int().positive().safe();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const witnessSchema = z.object({
  actorId: actorIdSchema,
  revision: revisionSchema,
  semanticDigest: digestSchema,
}).strict();

const optionsSchema = z.object({
  pageSize: z.number().int().min(1)
    .max(harnessProjectionReconciliationPageLimit),
  maxActors: z.number().int().min(1).max(MAX_ACTOR_SCAN),
}).strict();

type MaybePromise<T> = T | Promise<T>;

export interface HarnessActorProjectionReconciliationPortV2 {
  listActorIds(input: Readonly<{
    afterActorId: string | null;
    limit: number;
  }>): MaybePromise<unknown>;
  synchronizeProjectionWitness(actorId: string): MaybePromise<unknown>;
}

export interface HarnessActorProjectionReconcilerV2Options {
  readonly authority: HarnessActorProjectionReconciliationPortV2;
  readonly refresh: () => MaybePromise<void>;
  readonly pageSize?: number;
  readonly maxActors?: number;
}

export class HarnessActorProjectionReconcilerV2Error extends Error {
  readonly code: "corrupt_state" | "invalid_state";

  constructor(
    code: HarnessActorProjectionReconcilerV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessActorProjectionReconcilerV2Error";
    this.code = code;
  }
}

/**
 * Serializes durable witness convergence with renderer refreshes.
 *
 * The authority owns SQLite and semantic derivation. This coordinator owns no
 * provider effect: it only sequences convergence, bounded enumeration, and a
 * supplied renderer refresh after every requested reconciliation has fully
 * succeeded. A failed write or corrupt page never invokes refresh, and the
 * queue remains usable for a later replay.
 */
export class HarnessActorProjectionReconcilerV2 {
  readonly #authority: HarnessActorProjectionReconciliationPortV2;
  readonly #refresh: () => MaybePromise<void>;
  readonly #pageSize: number;
  readonly #maxActors: number;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(input: HarnessActorProjectionReconcilerV2Options) {
    const options = optionsSchema.parse({
      pageSize: input.pageSize ?? DEFAULT_PAGE_SIZE,
      maxActors: input.maxActors ?? DEFAULT_MAX_ACTORS,
    });
    this.#authority = input.authority;
    this.#refresh = input.refresh;
    this.#pageSize = options.pageSize;
    this.#maxActors = options.maxActors;
  }

  reconcileActor(actorIdValue: string): Promise<HarnessProjectionWitnessV2> {
    const actorId = actorIdSchema.parse(actorIdValue);
    return this.#enqueue(async () => {
      const witness = parseWitness(
        await this.#authority.synchronizeProjectionWitness(actorId),
      );
      if (witness.actorId !== actorId) {
        corrupt("projection witness belongs to another actor");
      }
      await this.#refresh();
      return witness;
    });
  }

  reconcileAll(): Promise<readonly HarnessProjectionWitnessV2[]> {
    return this.#enqueue(async () => {
      const witnesses: HarnessProjectionWitnessV2[] = [];
      let afterActorId: string | null = null;
      while (true) {
        const actorIds = parseActorPage(
          await this.#authority.listActorIds({
            afterActorId,
            limit: this.#pageSize,
          }),
          afterActorId,
          this.#pageSize,
        );
        if (witnesses.length + actorIds.length > this.#maxActors) {
          corrupt("actor projection reconciliation exceeds its bound");
        }
        for (const actorId of actorIds) {
          const witness = parseWitness(
            await this.#authority.synchronizeProjectionWitness(actorId),
          );
          if (witness.actorId !== actorId) {
            corrupt("projection witness belongs to another actor");
          }
          witnesses.push(witness);
        }
        if (actorIds.length < this.#pageSize) break;
        afterActorId = actorIds.at(-1)!;
      }
      await this.#refresh();
      return Object.freeze(witnesses);
    });
  }

  async settled(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new HarnessActorProjectionReconcilerV2Error(
        "invalid_state",
        "actor projection reconciler is closed",
      ));
    }
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseWitness(value: unknown): HarnessProjectionWitnessV2 {
  try {
    return Object.freeze(witnessSchema.parse(value));
  } catch (cause: unknown) {
    corrupt("projection witness authority returned invalid state", cause);
  }
}

function parseActorPage(
  value: unknown,
  afterActorId: string | null,
  limit: number,
): readonly string[] {
  let actorIds: readonly string[];
  try {
    actorIds = z.array(actorIdSchema).max(limit).parse(value);
  } catch (cause: unknown) {
    corrupt("actor projection authority returned an invalid page", cause);
  }
  let previous = afterActorId;
  for (const actorId of actorIds) {
    if (previous !== null && actorId <= previous) {
      corrupt("actor projection page is duplicated or out of order");
    }
    previous = actorId;
  }
  return Object.freeze(actorIds);
}

function corrupt(message: string, cause?: unknown): never {
  throw new HarnessActorProjectionReconcilerV2Error(
    "corrupt_state",
    message,
    cause,
  );
}
