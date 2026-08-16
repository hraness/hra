import { describe, expect, test } from "bun:test";

import {
  HarnessActorProjectionReconcilerV2,
  type HarnessActorProjectionReconciliationPortV2,
} from "../src/harness/actor-projection-reconciler-v2";

const alpha = "hactor_projection_alpha01";
const beta = "hactor_projection_beta001";
const gamma = "hactor_projection_gamma01";

function witness(actorId: string, revision = 1) {
  return {
    actorId,
    revision,
    semanticDigest: revision.toString(16).padStart(64, "0"),
  };
}

function orderedAuthority(
  actorIds: readonly string[],
  events: string[],
): HarnessActorProjectionReconciliationPortV2 {
  return {
    listActorIds: ({ afterActorId, limit }) => {
      events.push(`list:${afterActorId ?? "start"}`);
      return actorIds.filter((actorId) =>
        afterActorId === null || actorId > afterActorId
      ).slice(0, limit);
    },
    synchronizeProjectionWitness: (actorId) => {
      events.push(`sync:${actorId}`);
      return witness(actorId);
    },
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}

describe("HarnessActorProjectionReconcilerV2", () => {
  test("reconciles bounded canonical pages before one renderer refresh", async () => {
    const events: string[] = [];
    const reconciler = new HarnessActorProjectionReconcilerV2({
      authority: orderedAuthority([alpha, beta, gamma], events),
      refresh: () => {
        events.push("refresh");
      },
      pageSize: 2,
      maxActors: 3,
    });

    expect(await reconciler.reconcileAll()).toEqual([
      witness(alpha),
      witness(beta),
      witness(gamma),
    ]);
    expect(events).toEqual([
      "list:start",
      `sync:${alpha}`,
      `sync:${beta}`,
      `list:${beta}`,
      `sync:${gamma}`,
      "refresh",
    ]);
  });

  test("serializes concurrent requests through their completed refreshes", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let refreshCount = 0;
    const reconciler = new HarnessActorProjectionReconcilerV2({
      authority: orderedAuthority([alpha], events),
      refresh: () => {
        refreshCount += 1;
        events.push(`refresh:${String(refreshCount)}`);
        return refreshCount === 1 ? firstRefresh : Promise.resolve();
      },
    });

    const first = reconciler.reconcileActor(alpha);
    const second = reconciler.reconcileActor(alpha);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([`sync:${alpha}`, "refresh:1"]);

    releaseFirst();
    expect(await first).toEqual(witness(alpha));
    expect(await second).toEqual(witness(alpha));
    expect(events).toEqual([
      `sync:${alpha}`,
      "refresh:1",
      `sync:${alpha}`,
      "refresh:2",
    ]);
  });

  test("skips refresh after disappearance and keeps the queue replayable", async () => {
    const missing = new Error("actor disappeared");
    const events: string[] = [];
    const authority: HarnessActorProjectionReconciliationPortV2 = {
      listActorIds: () => [],
      synchronizeProjectionWitness: (actorId) => {
        events.push(`sync:${actorId}`);
        if (actorId === alpha) throw missing;
        return witness(actorId);
      },
    };
    const reconciler = new HarnessActorProjectionReconcilerV2({
      authority,
      refresh: () => {
        events.push("refresh");
      },
    });

    expect(await rejected(reconciler.reconcileActor(alpha))).toBe(missing);
    expect(events).toEqual([`sync:${alpha}`]);
    expect(await reconciler.reconcileActor(beta)).toEqual(witness(beta));
    expect(events).toEqual([`sync:${alpha}`, `sync:${beta}`, "refresh"]);
  });

  test("fails closed on duplicated pages and actor-count overflow", async () => {
    let refreshCount = 0;
    const duplicated = new HarnessActorProjectionReconcilerV2({
      authority: {
        listActorIds: () => [alpha, alpha],
        synchronizeProjectionWitness: (actorId) => witness(actorId),
      },
      refresh: () => {
        refreshCount += 1;
      },
      pageSize: 2,
    });
    expect(await rejected(duplicated.reconcileAll())).toMatchObject({
      code: "corrupt_state",
    });

    const overflow = new HarnessActorProjectionReconcilerV2({
      authority: orderedAuthority([alpha, beta], []),
      refresh: () => {
        refreshCount += 1;
      },
      pageSize: 2,
      maxActors: 1,
    });
    expect(await rejected(overflow.reconcileAll())).toMatchObject({
      code: "corrupt_state",
    });
    expect(refreshCount).toBe(0);
  });

  test("rejects new work after settling the serialized queue", async () => {
    const reconciler = new HarnessActorProjectionReconcilerV2({
      authority: orderedAuthority([], []),
      refresh: () => undefined,
    });
    await reconciler.settled();
    expect(await rejected(reconciler.reconcileActor(alpha))).toMatchObject({
      code: "invalid_state",
    });
  });
});
