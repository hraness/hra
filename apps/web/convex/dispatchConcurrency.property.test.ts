import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  dispatchClaimAllowed,
  dispatchRetryAllowed,
  runnerAuthorityDisposition,
  type PersistedRunnerAuthority,
} from "./dispatchLaws";

interface ClaimOutcome {
  readonly won: boolean;
  readonly claimFence?: number;
  readonly runId?: string;
}

/** A serializable model of the task + queued dispatch rows touched by claimDispatch. */
class DispatchClaimRace {
  private dispatchPhase: "queued" | "leased" = "queued";
  private taskStatus: "open" | "in_progress" = "open";
  private claimFence = 0;
  private taskClaimCount = 0;
  private boundRunCount = 0;
  private winner: string | null = null;

  claim(contender: string): ClaimOutcome {
    const allowed = dispatchClaimAllowed(
      {
        dispatchPhase: this.dispatchPhase,
        repositoryCapability: true,
        runnerBootMatches: true,
        runnerDesiredState: "active",
        runnerLeaseUntil: 2,
        runnerReady: true,
        availableCapacity: 1,
        taskReady: this.taskStatus === "open",
      },
      1,
    );
    if (!allowed) return { won: false };
    this.dispatchPhase = "leased";
    this.taskStatus = "in_progress";
    this.claimFence += 1;
    this.taskClaimCount += 1;
    this.boundRunCount += 1;
    this.winner = contender;
    return { won: true, claimFence: this.claimFence, runId: "run_queued" };
  }

  assertExactlyOnce(outcomes: readonly ClaimOutcome[]): void {
    expect(outcomes.filter(({ won }) => won)).toHaveLength(1);
    expect(this.taskClaimCount).toBe(1);
    expect(this.boundRunCount).toBe(1);
    expect(this.claimFence).toBe(1);
    expect(this.dispatchPhase).toBe("leased");
    expect(this.taskStatus).toBe("in_progress");
    expect(this.winner).not.toBeNull();
  }
}

/** Models the indexed retry-source read plus queued-child insert transaction. */
class DispatchRetryRace {
  private sourceAlreadyRetried = false;
  private anotherDispatchBlocksTask = false;
  private queuedChildren = 0;

  retry(): boolean {
    const allowed = dispatchRetryAllowed({
      sourcePhase: "failed",
      sourceSubmissionRejected: false,
      taskRevision: 7,
      expectedTaskRevision: 7,
      taskStatus: "open",
      taskHasCurrentClaim: false,
      sourceFenceMatches: true,
      anotherDispatchBlocksTask: this.anotherDispatchBlocksTask,
      sourceAlreadyRetried: this.sourceAlreadyRetried,
    });
    if (!allowed) return false;
    this.sourceAlreadyRetried = true;
    this.anotherDispatchBlocksTask = true;
    this.queuedChildren += 1;
    return true;
  }

  assertExactlyOnce(outcomes: readonly boolean[]): void {
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(this.queuedChildren).toBe(1);
  }
}

class RunnerAuthorityRace {
  private authority: PersistedRunnerAuthority | null = null;

  heartbeat(runnerPublicId: string): boolean {
    const installationId = `install_${runnerPublicId}`;
    const disposition = runnerAuthorityDisposition(
      this.authority,
      { runnerPublicId, installationId },
      1_000,
    );
    if (disposition.kind !== "acquire") return false;
    this.authority = {
      runnerPublicId,
      installationId,
      generation: disposition.generation,
      leaseUntil: 46_000,
    };
    return true;
  }

  assertExactlyOne(outcomes: readonly boolean[]): void {
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(this.authority).not.toBeNull();
    expect(this.authority?.generation).toBe(1);
    expect(this.authority?.leaseUntil).toBe(46_000);
  }
}

function shuffledContenders(seed: number): string[] {
  const contenders = Array.from({ length: 100 }, (_, index) => `runner_${index}`);
  let state = seed >>> 0;
  for (let index = contenders.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 16), 2_246_822_519) + 3_266_489_917) >>> 0;
    const swapIndex = state % (index + 1);
    const current = contenders[index];
    const swap = contenders[swapIndex];
    if (current === undefined || swap === undefined) continue;
    contenders[index] = swap;
    contenders[swapIndex] = current;
  }
  return contenders;
}

describe("dispatch claim concurrency", () => {
  test("a 100-installation first-heartbeat race elects one workspace authority", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const system = new RunnerAuthorityRace();
      const outcomes = shuffledContenders(seed).map((contender) => system.heartbeat(contender));
      system.assertExactlyOne(outcomes);
    }
  });

  test("workspace authority election is permutation-invariant", () => {
    assertProperty(
      fc.property(fc.integer({ min: 1, max: 2_147_483_647 }), (seed) => {
        const system = new RunnerAuthorityRace();
        const outcomes = shuffledContenders(seed).map((contender) => system.heartbeat(contender));
        system.assertExactlyOne(outcomes);
      }),
      { numRuns: 500 },
    );
  });

  test("a 100-way claim race binds exactly one fenced task claim and one queued run", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const system = new DispatchClaimRace();
      const outcomes = shuffledContenders(seed).map((contender) => system.claim(contender));
      system.assertExactlyOnce(outcomes);
    }
  });

  test("the exactly-once claim side effect is permutation-invariant", () => {
    assertProperty(
      fc.property(fc.integer({ min: 1, max: 2_147_483_647 }), (seed) => {
        const system = new DispatchClaimRace();
        const outcomes = shuffledContenders(seed).map((contender) => system.claim(contender));
        system.assertExactlyOnce(outcomes);
      }),
      { numRuns: 500 },
    );
  });

  test("distinct retry keys racing the same terminal attempt append one queued child", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const system = new DispatchRetryRace();
      const outcomes = shuffledContenders(seed).map(() => system.retry());
      system.assertExactlyOnce(outcomes);
    }
  });
});
