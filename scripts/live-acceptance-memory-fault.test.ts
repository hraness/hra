import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { EncryptedEnvelope } from "../src/cloud/contracts";
import {
  CanonicalMemoryTransportError,
  type CanonicalMemoryTransport,
} from "../src/cloud/canonical-memory-transport";
import type {
  CanonicalMemoryCreateResult,
  CanonicalMemoryHead,
  CanonicalMemoryOperation,
  CanonicalMemoryPullPage,
  CanonicalMemoryPushRequest,
  CanonicalMemorySpaceConfiguration,
  CanonicalMemorySpaceSummary,
  CanonicalMemoryWriteResult,
} from "../src/cloud/memory-sync-contracts";
import { OOMPA_VERSION } from "../src/version";
import type { LiveAcceptanceCandidate } from "./live-acceptance-installation";
import {
  LiveAcceptanceMemoryFaultController,
  LiveAcceptanceMemoryFaultError,
  liveAcceptanceMemoryFaultArmSchema,
  liveAcceptanceMemoryFaultStatusSchema,
} from "./live-acceptance-memory-fault";

const sha256 = (value: string): string => createHash("sha256")
  .update(value, "utf8")
  .digest("hex");

const cloudDeploymentUrl = "https://memory-acceptance.convex.cloud";
const candidate: LiveAcceptanceCandidate = {
  cloudTargetDigest: sha256(cloudDeploymentUrl),
  packageVersion: OOMPA_VERSION,
  sourceRevision: "a".repeat(40),
};
const runId = "00000000-0000-4000-8000-000000000601";
const spaceId = `memory_${"A".repeat(32)}`;
const unrelatedSpaceId = `memory_${"B".repeat(32)}`;
const genesisToken = "c".repeat(64);
const priorToken = "d".repeat(64);
const headToken = "e".repeat(64);

const envelope = (value: string): EncryptedEnvelope => ({
  algorithm: "A256GCM",
  ciphertext: value.repeat(24),
  keyVersion: 1,
  nonce: value.repeat(16),
});

const remoteHead = {
  headDigest: "1".repeat(64),
  operationSha256: "2".repeat(64),
  sequence: 1,
} as const;
const candidateHead = {
  headDigest: "3".repeat(64),
  operationSha256: "4".repeat(64),
  sequence: 2,
} as const;
const operation: CanonicalMemoryOperation = {
  adoptionProof: envelope("a"),
  genesisToken,
  headToken,
  operation: envelope("b"),
  priorToken,
  sequence: 2,
  terminalHeadProof: envelope("c"),
};
const pushRequest: CanonicalMemoryPushRequest = {
  expectedKeyVersion: 1,
  expectedRevision: 1,
  operations: [operation],
  spaceId,
};
const writeResult: CanonicalMemoryWriteResult = {
  acceptedHeadToken: headToken,
  acceptedSequence: 2,
  acceptedTerminalHeadProof: operation.terminalHeadProof,
  keyVersion: 1,
  replay: false,
  revision: 1,
  spaceId,
};
const configuration: CanonicalMemorySpaceConfiguration = {
  bindingPolicy: "one_project_one_space",
  encryptedDescriptor: envelope("d"),
  genesisHeadProof: envelope("e"),
  genesisToken,
  identityContract: 2,
  keyVersion: 1,
  revision: 1,
  spaceId,
  wrappedSpaceKey: envelope("f"),
};

const armInput = {
  candidateHead,
  hostedSpaceId: spaceId,
  remote: {
    genesisToken,
    head: remoteHead,
    headToken: priorToken,
    keyVersion: 1,
    revision: 1,
  },
} as const;

const historicalRequest = {
  afterHeadToken: priorToken,
  afterSequence: 1,
  expectedGenesisToken: genesisToken,
  expectedKeyVersion: 1,
  spaceId,
  terminalHeadToken: "f".repeat(64),
  terminalSequence: 3,
} as const;

const historicalPage: CanonicalMemoryPullPage = {
  done: false,
  operations: [operation],
  spaceId,
  terminalHeadToken: historicalRequest.terminalHeadToken,
  terminalSequence: historicalRequest.terminalSequence,
};

const deferred = <T>() => {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

class MemoryTransport implements CanonicalMemoryTransport {
  readonly calls: string[] = [];
  readonly pullRequests: Parameters<CanonicalMemoryTransport["pull"]>[0][] = [];
  readonly pushRequests: CanonicalMemoryPushRequest[] = [];
  pullPage = historicalPage;
  pullGate: Promise<void> | undefined;
  pushResult = writeResult;
  pushGate: Promise<void> | undefined;

  async create(): Promise<CanonicalMemoryCreateResult> {
    this.calls.push("create");
    return { ...configuration, replay: false };
  }

  async get(): Promise<CanonicalMemorySpaceConfiguration> {
    this.calls.push("get");
    return configuration;
  }

  async head(input: { spaceId: string }): Promise<CanonicalMemoryHead> {
    this.calls.push("head");
    return {
      genesisToken,
      headToken: input.spaceId === spaceId ? priorToken : genesisToken,
      keyVersion: 1,
      revision: 1,
      sequence: input.spaceId === spaceId ? 1 : 0,
      spaceId: input.spaceId,
      terminalHeadProof: operation.terminalHeadProof,
    };
  }

  async list(): Promise<readonly CanonicalMemorySpaceSummary[]> {
    this.calls.push("list");
    return [];
  }

  async pull(
    input: Parameters<CanonicalMemoryTransport["pull"]>[0],
  ): Promise<CanonicalMemoryPullPage> {
    this.calls.push("pull");
    this.pullRequests.push(input);
    await this.pullGate;
    return this.pullPage;
  }

  async push(input: CanonicalMemoryPushRequest): Promise<CanonicalMemoryWriteResult> {
    this.calls.push("push");
    this.pushRequests.push(input);
    await this.pushGate;
    return this.pushResult;
  }
}

const controller = (): LiveAcceptanceMemoryFaultController =>
  new LiveAcceptanceMemoryFaultController({
    candidate,
    cloudDeploymentUrl,
    device: "a",
    runId,
  });

describe("live-acceptance canonical-memory response drop", () => {
  test("atomically drops one exact push, blocks its generation, and proves later historical recovery", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    const pushGate = deferred<undefined>();
    base.pushGate = pushGate.promise;
    const firstGeneration = fault.beginGeneration();
    const transport = fault.decorate(firstGeneration, base);
    const armed = fault.arm(armInput);
    expect(armed).toMatchObject({
      currentGeneration: 1,
      phase: "armed",
    });

    const pushed = transport.push(pushRequest);
    await Bun.sleep(0);
    expect(fault.status()).toMatchObject({ phase: "dropping" });
    await expect(transport.push(pushRequest)).rejects.toMatchObject({
      effect: "none",
      name: "CanonicalMemoryTransportError",
    });
    await expect(transport.get({ spaceId })).rejects.toMatchObject({ effect: "none" });
    expect(base.calls).toEqual(["push"]);
    expect(base.pushRequests).toEqual([pushRequest]);
    expect(base.pushRequests[0]).toBe(pushRequest);
    expect(await transport.head({ spaceId: unrelatedSpaceId })).toMatchObject({
      spaceId: unrelatedSpaceId,
    });

    pushGate.resolve(undefined);
    await expect(pushed).rejects.toMatchObject({
      effect: "indeterminate",
      name: "CanonicalMemoryTransportError",
    });
    const dropped = fault.status();
    expect(dropped).toMatchObject({
      currentGeneration: 1,
      phase: "dropped_blocking",
      proof: {
        candidateHead,
        droppedGeneration: 1,
        pushDispatchCount: 1,
        sameGenerationRefusalCount: 2,
        sequence: 2,
      },
    });
    expect(dropped.proof?.hostedSpaceIdSha256).toBe(sha256(spaceId));
    expect(dropped.proof?.structuredRequestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(dropped.proof?.wireOperationSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(transport.pull(historicalRequest)).rejects.toMatchObject({ effect: "none" });

    fault.endGeneration({ exitCode: 0, generation: firstGeneration, reason: "suspend" });
    expect(fault.status()).toMatchObject({ currentGeneration: null, phase: "suspended" });

    const pullGate = deferred<undefined>();
    base.pullGate = pullGate.promise;
    const secondGeneration = fault.beginGeneration();
    const resumed = fault.decorate(secondGeneration, base);
    expect(fault.status()).toMatchObject({ currentGeneration: 2, phase: "waiting_historical" });
    const pulled = resumed.pull(historicalRequest);
    await Bun.sleep(0);
    expect(fault.status()).toMatchObject({ phase: "proving_historical" });
    await expect(resumed.pull(historicalRequest)).rejects.toMatchObject({ effect: "none" });
    expect(base.calls.filter((call) => call === "pull")).toHaveLength(1);
    expect(base.pullRequests[0]).toBe(historicalRequest);
    pullGate.resolve(undefined);
    expect(await pulled).toEqual(historicalPage);

    const recovered = fault.status();
    expect(recovered).toMatchObject({
      currentGeneration: 2,
      historical: {
        afterSequence: 1,
        generation: 2,
        terminalSequence: 3,
      },
      phase: "historical_proved",
      proof: { sameGenerationRefusalCount: 3 },
    });
    expect(recovered.historical?.firstOperationSha256)
      .toBe(recovered.proof?.wireOperationSha256);
    expect(base.calls.filter((call) => call === "push")).toHaveLength(1);

    const finalized = fault.finalize({
      candidateBindingDigest: recovered.proof?.candidateBindingDigest ?? "",
      laterTerminalSequence: 3,
    });
    expect(finalized.phase).toBe("finalized");
    expect(await resumed.get({ spaceId })).toBe(configuration);
    expect(base.calls.at(-1)).toBe("get");
  });

  test("does not publish a pending drop after close and cannot be reused", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    const pushGate = deferred<undefined>();
    base.pushGate = pushGate.promise;
    const generation = fault.beginGeneration();
    const transport = fault.decorate(generation, base);
    fault.arm(armInput);
    const pushed = transport.push(pushRequest);
    await Bun.sleep(0);

    fault.close();
    pushGate.resolve(undefined);
    await expect(pushed).rejects.toEqual(new LiveAcceptanceMemoryFaultError("state_invalid"));
    expect(fault.status()).toEqual({ currentGeneration: null, phase: "closed" });
    expect(() => fault.beginGeneration()).toThrow("state_invalid");
    expect(() => fault.decorate(generation, base)).toThrow("state_invalid");
  });

  test("records a nonthrowing lifecycle failure while a drop is pending", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    const pushGate = deferred<undefined>();
    base.pushGate = pushGate.promise;
    const generation = fault.beginGeneration();
    fault.arm(armInput);
    const secondPush = fault.decorate(generation, base).push(pushRequest);
    await Bun.sleep(0);
    expect(() => fault.endGeneration({
      exitCode: 0,
      generation,
      reason: "suspend",
    })).not.toThrow();
    expect(fault.status()).toMatchObject({
      currentGeneration: null,
      failureCode: "generation_invalid",
      phase: "failed",
    });
    expect(() => fault.beginGeneration()).toThrow("generation_invalid");
    pushGate.resolve(undefined);
    await expect(secondPush).rejects.toThrow("generation_invalid");
  });

  test("fails an invalid nominated push before the base transport", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    const generation = fault.beginGeneration();
    const transport = fault.decorate(generation, base);
    fault.arm(armInput);
    await expect(transport.push({
      ...pushRequest,
      operations: [{ ...operation, adoptionProof: null }],
    })).rejects.toEqual(new LiveAcceptanceMemoryFaultError("push_invalid"));
    expect(base.calls).toEqual([]);
    expect(fault.status()).toMatchObject({ failureCode: "push_invalid", phase: "failed" });
  });

  test("rejects an invalid successful push response without publishing drop proof", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    base.pushResult = { ...writeResult, replay: true };
    const generation = fault.beginGeneration();
    const transport = fault.decorate(generation, base);
    fault.arm(armInput);

    await expect(transport.push(pushRequest)).rejects.toEqual(
      new LiveAcceptanceMemoryFaultError("response_invalid"),
    );
    expect(base.pushRequests).toEqual([pushRequest]);
    expect(fault.status()).toEqual({
      currentGeneration: 1,
      failureCode: "response_invalid",
      phase: "failed",
    });
  });

  test("strictly rejects a malformed foreign push response without publishing drop proof", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    Object.defineProperty(base, "pushResult", {
      configurable: true,
      value: {
        ...writeResult,
        acceptedTerminalHeadProof: {
          ...writeResult.acceptedTerminalHeadProof,
          algorithm: "unreviewed-cipher",
        },
      },
    });
    const generation = fault.beginGeneration();
    const transport = fault.decorate(generation, base);
    fault.arm(armInput);

    await expect(transport.push(pushRequest)).rejects.toEqual(
      new LiveAcceptanceMemoryFaultError("response_invalid"),
    );
    expect(base.pushRequests).toEqual([pushRequest]);
    expect(fault.status()).toEqual({
      currentGeneration: 1,
      failureCode: "response_invalid",
      phase: "failed",
    });
  });

  test("does not publish historical proof after its generation ends", async () => {
    const fault = controller();
    const base = new MemoryTransport();
    const firstGeneration = fault.beginGeneration();
    const firstTransport = fault.decorate(firstGeneration, base);
    fault.arm(armInput);
    await expect(firstTransport.push(pushRequest)).rejects.toBeInstanceOf(
      CanonicalMemoryTransportError,
    );
    fault.endGeneration({ exitCode: 0, generation: firstGeneration, reason: "suspend" });

    const pullGate = deferred<undefined>();
    base.pullGate = pullGate.promise;
    const secondGeneration = fault.beginGeneration();
    const pulled = fault.decorate(secondGeneration, base).pull(historicalRequest);
    await Bun.sleep(0);
    expect(fault.status().phase).toBe("proving_historical");
    expect(() => fault.endGeneration({
      exitCode: 0,
      generation: secondGeneration,
      reason: "suspend",
    })).not.toThrow();
    pullGate.resolve(undefined);
    await expect(pulled).rejects.toThrow("generation_invalid");
    expect(fault.status()).toMatchObject({
      failureCode: "generation_invalid",
      phase: "failed",
    });
    expect(fault.status().historical).toBeUndefined();
    expect(() => fault.finalize({
      candidateBindingDigest: "a".repeat(64),
      laterTerminalSequence: 3,
    })).toThrow("generation_invalid");
  });

  test("keeps the fault unavailable without an exact A candidate and target", async () => {
    expect(() => new LiveAcceptanceMemoryFaultController({
      candidate,
      cloudDeploymentUrl: "https://other.convex.cloud",
      device: "a",
      runId,
    })).toThrow("candidate_invalid");

    const base = new MemoryTransport();
    const fault = new LiveAcceptanceMemoryFaultController({
      candidate,
      cloudDeploymentUrl,
      device: "b",
      runId,
    });
    const generation = fault.beginGeneration();
    expect(fault.status()).toEqual({ currentGeneration: 1, phase: "unavailable" });
    expect(await fault.decorate(generation, base).get({ spaceId })).toBe(configuration);
    expect(() => fault.arm(armInput)).toThrow("state_invalid");
  });

  test("rejects incoherent foreign control frames", () => {
    expect(liveAcceptanceMemoryFaultArmSchema.safeParse({
      ...armInput,
      candidateHead: { ...candidateHead, sequence: 3 },
    }).success).toBeFalse();
    expect(liveAcceptanceMemoryFaultStatusSchema.safeParse({
      currentGeneration: 1,
      phase: "finalized",
    }).success).toBeFalse();
    expect(liveAcceptanceMemoryFaultStatusSchema.safeParse({
      currentGeneration: null,
      failureCode: "state_invalid",
      phase: "idle",
    }).success).toBeFalse();
    expect(liveAcceptanceMemoryFaultStatusSchema.safeParse({
      currentGeneration: 2,
      historical: {
        afterSequence: 0,
        firstOperationSha256: "a".repeat(64),
        generation: 2,
        terminalSequence: 3,
      },
      phase: "historical_proved",
      proof: {
        candidateBindingDigest: "b".repeat(64),
        candidateHead,
        droppedGeneration: 1,
        hostedSpaceIdSha256: "c".repeat(64),
        pushDispatchCount: 1,
        sameGenerationRefusalCount: 0,
        sequence: 2,
        structuredRequestSha256: "d".repeat(64),
        wireOperationSha256: "e".repeat(64),
      },
    }).success).toBeFalse();
  });
});
