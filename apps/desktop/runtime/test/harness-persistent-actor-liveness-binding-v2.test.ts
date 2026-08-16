import { describe, expect, test } from "bun:test";

import {
  PersistentActorLivenessBindingV2,
  type PersistentActorLivenessBindingTargetV2,
} from "../src/harness/persistent-actor-liveness-binding-v2";
import type { PersistentActorLivenessWakeV2 } from
  "../src/harness/persistent-actor-liveness-v2";
import type { SessionTurnLifecycle } from "../src/sessions/session-service";

const terminalEvent: SessionTurnLifecycle = {
  accountProfileId: "acct_liveness_binding_01",
  threadId: "provider_thread_liveness_binding_01",
  turnId: "provider_turn_liveness_binding_01",
  status: "completed",
};

function rejected<Value>(promise: Promise<Value>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (cause: unknown) => cause,
  );
}

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected throw");
}

function target(): Readonly<{
  calls: string[];
  events: SessionTurnLifecycle[];
  wakes: PersistentActorLivenessWakeV2[];
  value: PersistentActorLivenessBindingTargetV2;
}> {
  const calls: string[] = [];
  const events: SessionTurnLifecycle[] = [];
  const wakes: PersistentActorLivenessWakeV2[] = [];
  return {
    calls,
    events,
    wakes,
    value: {
      requestReconciliation: (input = {}) => {
        calls.push("requestReconciliation");
        wakes.push(input);
      },
      observe: (event) => {
        calls.push("observe");
        events.push(event);
      },
      ensureCurrent: () => {
        calls.push("ensureCurrent");
        return Promise.resolve();
      },
      settled: () => {
        calls.push("settled");
        return Promise.resolve();
      },
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
    },
  };
}

describe("PersistentActorLivenessBindingV2", () => {
  test("drops boot hints but fails work and settlement before the pump is bound", async () => {
    const binding = new PersistentActorLivenessBindingV2();

    expect(binding.observe(terminalEvent)).toBeUndefined();
    expect(await rejected(binding.ensureCurrent())).toMatchObject({
      code: "not_bound",
    });
    expect(await rejected(binding.settled())).toMatchObject({
      code: "not_bound",
    });

    const delegate = target();
    binding.bind(delegate.value);
    await binding.ensureCurrent();
    expect(delegate.calls).toEqual(["ensureCurrent"]);
  });

  test("close before bind is terminal, idempotent, and requires no pump", async () => {
    const binding = new PersistentActorLivenessBindingV2();

    const closing = binding.close();
    expect(binding.close()).toBe(closing);
    expect(binding.settled()).toBe(closing);
    await closing;
    expect(thrown(() => binding.observe(terminalEvent))).toMatchObject({
      code: "closed",
    });
    expect(await rejected(binding.ensureCurrent())).toMatchObject({
      code: "closed",
    });
    expect(thrown(() => binding.bind(target().value))).toMatchObject({
      code: "closed",
    });
    expect(binding.requestReconciliation()).toBeUndefined();
  });

  test("coalesces pre-bind reconciliation wakes and delivers one on bind", () => {
    const binding = new PersistentActorLivenessBindingV2();
    const delegate = target();

    binding.requestReconciliation({
      incarnationIds: ["hincarnation_liveness_wake_02"],
    });
    binding.requestReconciliation({
      incarnationIds: ["hincarnation_liveness_wake_01"],
    });
    expect(delegate.calls).toEqual([]);
    binding.bind(delegate.value);
    expect(delegate.calls).toEqual(["requestReconciliation"]);
    expect(delegate.wakes).toEqual([{
      incarnationIds: [
        "hincarnation_liveness_wake_01",
        "hincarnation_liveness_wake_02",
      ],
    }]);

    binding.requestReconciliation({
      incarnationIds: ["hincarnation_liveness_wake_03"],
    });
    expect(delegate.calls).toEqual([
      "requestReconciliation",
      "requestReconciliation",
    ]);
    expect(delegate.wakes.at(-1)).toEqual({
      incarnationIds: ["hincarnation_liveness_wake_03"],
    });
  });

  test("delegates before close and rejects every work surface afterward", async () => {
    const calls: string[] = [];
    const events: SessionTurnLifecycle[] = [];
    const ensured = Promise.resolve();
    const settled = Promise.resolve();
    const closed = Promise.resolve();
    const binding = new PersistentActorLivenessBindingV2();
    expect(binding.bind({
      requestReconciliation: () => {
        calls.push("requestReconciliation");
      },
      observe: (event) => {
        calls.push("observe");
        events.push(event);
      },
      ensureCurrent: () => {
        calls.push("ensureCurrent");
        return ensured;
      },
      settled: () => {
        calls.push("settled");
        return settled;
      },
      close: () => {
        calls.push("close");
        return closed;
      },
    })).toBe("bound");

    expect(binding.requestReconciliation()).toBeUndefined();
    expect(binding.observe(terminalEvent)).toBeUndefined();
    expect(binding.ensureCurrent()).toBe(ensured);
    expect(binding.settled()).toBe(settled);
    expect(binding.close()).toBe(closed);
    expect(binding.close()).toBe(closed);
    expect(binding.settled()).toBe(closed);
    expect(thrown(() => binding.observe(terminalEvent))).toMatchObject({
      code: "closed",
    });
    expect(await rejected(binding.ensureCurrent())).toMatchObject({
      code: "closed",
    });
    expect(events).toEqual([terminalEvent]);
    expect(calls).toEqual([
      "requestReconciliation",
      "observe",
      "ensureCurrent",
      "settled",
      "close",
    ]);
  });

  test("rejects every second binding and retains the original target", async () => {
    const first = target();
    const second = target();
    const binding = new PersistentActorLivenessBindingV2();
    binding.bind(first.value);

    expect(thrown(() => binding.bind(first.value))).toMatchObject({
      code: "already_bound",
    });
    expect(thrown(() => binding.bind(second.value))).toMatchObject({
      code: "already_bound",
    });
    await binding.ensureCurrent();
    expect(first.calls).toEqual(["ensureCurrent"]);
    expect(second.calls).toEqual([]);
  });

  test("preserves synchronous throws and terminal promise rejections", async () => {
    const observationFailure = new Error("observation failed");
    const ensureFailure = new Error("ensure failed");
    const settlementFailure = new Error("settlement failed");
    const closeFailure = new Error("close failed");
    const ensured = Promise.reject(ensureFailure);
    const settled = Promise.reject(settlementFailure);
    const closed = Promise.reject(closeFailure);
    void ensured.catch(() => undefined);
    void settled.catch(() => undefined);
    void closed.catch(() => undefined);
    const binding = new PersistentActorLivenessBindingV2();
    binding.bind({
      requestReconciliation: () => undefined,
      observe: () => {
        throw observationFailure;
      },
      ensureCurrent: () => ensured,
      settled: () => settled,
      close: () => closed,
    });

    expect(() => binding.observe(terminalEvent)).toThrow(observationFailure);
    expect(binding.ensureCurrent()).toBe(ensured);
    expect(await rejected(binding.ensureCurrent())).toBe(ensureFailure);
    expect(binding.settled()).toBe(settled);
    expect(await rejected(binding.settled())).toBe(settlementFailure);
    expect(binding.close()).toBe(closed);
    expect(await rejected(binding.close())).toBe(closeFailure);
  });

  test("a synchronous close failure leaves the bound delegate retryable", async () => {
    const failure = new Error("synchronous close failed");
    const closed = Promise.resolve();
    let attempts = 0;
    const binding = new PersistentActorLivenessBindingV2();
    binding.bind({
      requestReconciliation: () => undefined,
      observe: () => undefined,
      ensureCurrent: () => Promise.resolve(),
      settled: () => Promise.resolve(),
      close: () => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return closed;
      },
    });

    expect(() => binding.close()).toThrow(failure);
    expect(binding.close()).toBe(closed);
    expect(binding.close()).toBe(closed);
    await closed;
    expect(attempts).toBe(2);
  });
});
