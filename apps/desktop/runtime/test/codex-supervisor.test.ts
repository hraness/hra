import { describe, expect, test } from "bun:test";
import {
  CodexRestartSupervisor,
  type CodexGenerationEndReason,
  type CodexSupervisorState,
  type SupervisedCodexGeneration,
} from "../src/codex";

class FakeGeneration implements SupervisedCodexGeneration {
  readonly expired: CodexGenerationEndReason[] = [];
  readonly generation: number;

  constructor(generation: number) {
    this.generation = generation;
  }

  expire(reason: CodexGenerationEndReason): void {
    this.expired.push(reason);
  }
}

const policy = {
  initialDelayMs: 10,
  maximumDelayMs: 25,
  maximumRestartAttempts: 4,
} as const;

describe("CodexRestartSupervisor", () => {
  test("allocates after a persisted generation floor and gates projection before creation", async () => {
    const order: string[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      initialGeneration: 40,
      policy,
      beforeCreate: async (generation) => {
        order.push(`persist:${String(generation)}`);
        await Promise.resolve();
      },
      create: (generation) => {
        order.push(`create:${String(generation)}`);
        return Promise.resolve(new FakeGeneration(generation));
      },
      onState: (state) => {
        if (state.type === "starting" || state.type === "running") {
          order.push(`${state.type}:${String(state.generation)}`);
        }
      },
      sleep: () => Promise.resolve(),
    });

    expect(supervisor.generation).toBe(40);
    expect(supervisor.state).toEqual({ type: "idle", generation: 40 });
    expect((await supervisor.start()).generation).toBe(41);
    expect(order).toEqual([
      "persist:41",
      "starting:41",
      "create:41",
      "running:41",
    ]);
  });

  test("recovers a failed initial persistence gate through bounded backoff without reusing generation", async () => {
    const creates: number[] = [];
    const starting: number[] = [];
    let rejectNextGate = true;
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      initialGeneration: 7,
      policy,
      beforeCreate: (generation) => {
        if (rejectNextGate) {
          rejectNextGate = false;
          return Promise.reject(new Error(`fixture persistence failure ${String(generation)}`));
        }
        return Promise.resolve();
      },
      create: (generation) => {
        creates.push(generation);
        return Promise.resolve(new FakeGeneration(generation));
      },
      onState: (state) => {
        if (state.type === "starting") starting.push(state.generation);
      },
      sleep: () => Promise.resolve(),
    });

    expect((await supervisor.start()).generation).toBe(9);
    expect(supervisor.generation).toBe(9);
    expect(supervisor.state).toEqual({ type: "running", generation: 9 });
    expect(creates).toEqual([9]);
    expect(starting).toEqual([9]);
  });

  test("rejects invalid persisted generation floors", () => {
    for (const initialGeneration of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new CodexRestartSupervisor<FakeGeneration>({
            initialGeneration,
            policy,
            create: (generation) => Promise.resolve(new FakeGeneration(generation)),
          }),
      ).toThrow("initialGeneration must be a nonnegative safe integer");
    }
  });

  test("coalesces concurrent initial starts into one process generation", async () => {
    let releaseCreate: () => void = () => undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const creates: number[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: async (generation) => {
        creates.push(generation);
        await createGate;
        return new FakeGeneration(generation);
      },
      sleep: () => Promise.resolve(),
    });

    const first = supervisor.start();
    const second = supervisor.start();
    await Promise.resolve();
    expect(creates).toEqual([1]);
    releaseCreate();
    expect((await first).generation).toBe(1);
    expect((await second).generation).toBe(1);
    expect(supervisor.generation).toBe(1);
  });

  test("increments generation for every launch attempt and caps exponential backoff", async () => {
    const creates: number[] = [];
    const sleeps: number[] = [];
    const states: CodexSupervisorState[] = [];
    const first = new FakeGeneration(1);
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: (generation) => {
        creates.push(generation);
        if (generation === 2) return Promise.reject(new Error("fixture launch failure"));
        return Promise.resolve(generation === 1 ? first : new FakeGeneration(generation));
      },
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
      onState: (state) => {
        states.push(state);
      },
    });

    expect((await supervisor.start()).generation).toBe(1);
    const restarted = await supervisor.restart("process_exited");
    expect(restarted?.generation).toBe(3);
    expect(first.expired).toEqual(["process_exited"]);
    expect(creates).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([10, 20]);
    expect(supervisor.generation).toBe(3);
    expect(states.at(-1)).toEqual({ type: "running", generation: 3 });
  });

  test("bounds initial create failures with the same restart budget and backoff", async () => {
    const creates: number[] = [];
    const sleeps: number[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: (generation) => {
        creates.push(generation);
        return Promise.reject(new Error("fixture launch failure"));
      },
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
    });

    const [initial] = await Promise.allSettled([supervisor.start()]);
    expect(initial?.status).toBe("rejected");
    expect(creates).toEqual([1, 2, 3, 4, 5]);
    expect(sleeps).toEqual([10, 20, 25, 25]);
    expect(supervisor.state).toEqual({ type: "failed", generation: 5, attempts: 4 });

    const [replayed] = await Promise.allSettled([supervisor.start()]);
    expect(replayed?.status).toBe("rejected");
    expect(creates).toEqual([1, 2, 3, 4, 5]);
  });

  test("an initial recovery retains its consumed budget until stability evidence", async () => {
    let now = 0;
    const creates: number[] = [];
    const sleeps: number[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy: { ...policy, maximumRestartAttempts: 2 },
      create: (generation) => {
        creates.push(generation);
        return generation === 1
          ? Promise.reject(new Error("fixture launch failure"))
          : Promise.resolve(new FakeGeneration(generation));
      },
      now: () => now,
      restartBudgetResetMs: 100,
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
    });

    expect((await supervisor.start()).generation).toBe(2);
    now = 99;
    expect((await supervisor.restart("process_exited"))?.generation).toBe(3);
    expect(await supervisor.restart("process_exited")).toBeNull();
    expect(sleeps).toEqual([10, 20]);

    expect((await supervisor.restart("restart_requested"))?.generation).toBe(4);
    now = 199;
    expect((await supervisor.restart("process_exited"))?.generation).toBe(5);
    expect(creates).toEqual([1, 2, 3, 4, 5]);
  });

  test("coalesces concurrent restart calls and stops after the bounded attempts", async () => {
    const creates: number[] = [];
    const sleeps: number[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: (generation) => {
        creates.push(generation);
        if (generation > 1) return Promise.reject(new Error("fixture launch failure"));
        return Promise.resolve(new FakeGeneration(generation));
      },
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
    });

    await supervisor.start();
    const firstRestart = supervisor.restart("protocol_fault");
    const secondRestart = supervisor.restart("restart_requested");
    expect(secondRestart).toBe(firstRestart);
    expect(await firstRestart).toBeNull();
    expect(creates).toEqual([1, 2, 3, 4, 5]);
    expect(sleeps).toEqual([10, 20, 25, 25]);
    expect(supervisor.state).toEqual({ type: "failed", generation: 5, attempts: 4 });
    expect(supervisor.current).toBeNull();
  });

  test("bounds repeated crashes after generations successfully launch", async () => {
    const creates: number[] = [];
    const sleeps: number[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy: { ...policy, maximumRestartAttempts: 3 },
      create: (generation) => {
        creates.push(generation);
        return Promise.resolve(new FakeGeneration(generation));
      },
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
    });

    await supervisor.start();
    expect((await supervisor.restart("process_exited"))?.generation).toBe(2);
    expect((await supervisor.restart("process_exited"))?.generation).toBe(3);
    expect((await supervisor.restart("process_exited"))?.generation).toBe(4);
    expect(await supervisor.restart("process_exited")).toBeNull();
    expect(creates).toEqual([1, 2, 3, 4]);
    expect(sleeps).toEqual([10, 20, 25]);
    expect(supervisor.state).toEqual({ type: "failed", generation: 4, attempts: 3 });
  });

  test("ordinary start cannot reopen an exhausted automatic restart budget", async () => {
    const creates: number[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy: { ...policy, maximumRestartAttempts: 2 },
      create: (generation) => {
        creates.push(generation);
        return generation === 1 || generation === 4
          ? Promise.resolve(new FakeGeneration(generation))
          : Promise.reject(new Error("fixture launch failure"));
      },
      sleep: () => Promise.resolve(),
    });

    await supervisor.start();
    expect(await supervisor.restart("process_exited")).toBeNull();
    expect(supervisor.state).toEqual({ type: "failed", generation: 3, attempts: 2 });
    expect(creates).toEqual([1, 2, 3]);

    const [ordinaryStart] = await Promise.allSettled([supervisor.start()]);
    expect(ordinaryStart?.status).toBe("rejected");
    expect(supervisor.state).toEqual({ type: "failed", generation: 3, attempts: 2 });
    expect(supervisor.generation).toBe(3);
    expect(creates).toEqual([1, 2, 3]);

    expect((await supervisor.restart("restart_requested"))?.generation).toBe(4);
    expect(supervisor.state).toEqual({ type: "running", generation: 4 });
    expect(creates).toEqual([1, 2, 3, 4]);
  });

  test("does not swallow a replacement generation fault during restart convergence", async () => {
    const creates: FakeGeneration[] = [];
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: (generation) => {
        const created = new FakeGeneration(generation);
        creates.push(created);
        return Promise.resolve(created);
      },
      sleep: () => Promise.resolve(),
      onState: (state) => {
        if (state.type === "running" && state.generation === 2) {
          void supervisor.restart("process_exited", state.generation);
        }
      },
    });

    await supervisor.start();
    const converged = await supervisor.restart("process_exited", 1);
    expect(converged?.generation).toBe(3);
    expect(supervisor.current?.generation).toBe(3);
    expect(creates.map(({ generation }) => generation)).toEqual([1, 2, 3]);
    expect(creates[1]?.expired).toEqual(["process_exited"]);
  });

  test("a stable generation or explicit restart reopens the restart budget", async () => {
    let now = 0;
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy: { ...policy, maximumRestartAttempts: 1 },
      create: (generation) => Promise.resolve(new FakeGeneration(generation)),
      now: () => now,
      restartBudgetResetMs: 100,
      sleep: () => Promise.resolve(),
    });

    await supervisor.start();
    await supervisor.restart("process_exited");
    now = 100;
    expect((await supervisor.restart("process_exited"))?.generation).toBe(3);
    expect((await supervisor.restart("restart_requested"))?.generation).toBe(4);
  });

  test("expires the active generation on stop without creating another", async () => {
    const created = new FakeGeneration(1);
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: () => Promise.resolve(created),
      sleep: () => Promise.resolve(),
    });
    await supervisor.start();
    await supervisor.stop();
    expect(created.expired).toEqual(["stopped"]);
    expect(supervisor.state).toEqual({ type: "stopped", generation: 1 });
  });

  test("expires a factory result that claims the wrong generation", async () => {
    const mismatched = new FakeGeneration(99);
    const supervisor = new CodexRestartSupervisor<FakeGeneration>({
      policy,
      create: () => Promise.resolve(mismatched),
      sleep: () => Promise.resolve(),
    });

    const [result] = await Promise.allSettled([supervisor.start()]);
    expect(result?.status).toBe("rejected");
    expect(mismatched.expired).toEqual([
      "protocol_fault",
      "protocol_fault",
      "protocol_fault",
      "protocol_fault",
      "protocol_fault",
    ]);
    expect(supervisor.state).toEqual({ type: "failed", generation: 5, attempts: 4 });
  });
});
