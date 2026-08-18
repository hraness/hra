import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  RLM_V2_MAX_FUEL,
  RlmV2OperationReplayRequiredError,
  parseRlmV2Caller,
  parseRlmV2Program,
  type RlmV2Capability,
  type RlmV2JsonValue,
  type RlmV2Operation,
  type RlmV2OperationPort,
  type RlmV2Program,
} from "../src/harness/rlm-v2";
import type {
  RlmReceiptRecord,
  RlmRunRecord,
} from "../src/harness/rlm-run-authority-v2";
import {
  RlmRuntimeV2,
  deriveRlmRuntimeAdmissionDigest,
  type RlmRuntimeAdmission,
  type RlmRuntimeCallerPort,
  type RlmRuntimeEncryptedValuePort,
  type RlmRuntimeRunAuthorityPort,
  type RlmRuntimeValueIdentity,
} from "../src/harness/rlm-runtime-v2";

const createdAt = "2026-08-06T12:00:00.000Z";
const deadline = "2099-01-01T00:00:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;

const capabilityForOperation: Readonly<Record<RlmV2Operation, RlmV2Capability>> = {
  "context.snapshot": "context.read",
  "context.search": "context.read",
  "context.slice": "context.read",
  "context.materialize": "context.materialize",
  "heap.put": "heap.write",
  "heap.get": "heap.read",
  "heap.list": "heap.read",
  "agent.spawn": "agent.spawn",
  "agent.send": "agent.message",
  "agent.status": "agent.wait",
  "agent.waitAny": "agent.wait",
  "agent.waitAll": "agent.wait",
  "agent.result": "agent.wait",
  "agent.cancel": "agent.cancel",
  "routing.inspect": "routing.inspect",
  "harness.propose": "harness.propose",
};

function caller(
  capabilities: readonly RlmV2Capability[] = ["context.read"],
  identity: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
  }> = {
    epochId: "hepoch_runtime_default01",
    actorId: "hactor_runtime_default01",
    turnId: "hturn_runtime_default001",
  },
) {
  return parseRlmV2Caller({
    ...identity,
    capabilities,
    admittedFeatures: ["boundedPrograms"],
    semanticWitnessDigests: [digestA],
    budget: {
      depthRemaining: 3,
      activeDescendantLimit: 8,
      durableDescendantLimit: 50,
      tokenBudget: 100_000,
      deadline,
      heapByteLimit: 16 * 1024 * 1024,
      contextValueByteLimit: 1024 * 1024,
      messageByteLimit: 128 * 1024,
      laneAuthority: "readOnly",
    },
  });
}

function literalProgram(value: RlmV2JsonValue = { ok: true }): RlmV2Program {
  return parseRlmV2Program({
    version: 2,
    capabilities: [],
    steps: [],
    result: { kind: "literal", value },
  });
}

function callProgram(operation: RlmV2Operation): RlmV2Program {
  return parseRlmV2Program({
    version: 2,
    capabilities: [capabilityForOperation[operation]],
    steps: [{
      kind: "call",
      as: "answer",
      operation,
      arguments: {},
    }],
    result: { kind: "variable", name: "answer" },
  });
}

function admission(
  suffix: string,
  program: RlmV2Program,
  callerValue = caller(program.capabilities),
): RlmRuntimeAdmission {
  const identity = {
    epochId: `hepoch_runtime_${suffix}`,
    actorId: `hactor_runtime_${suffix}`,
    turnId: `hturn_runtime_${suffix}`,
  } as const;
  return {
    runId: `rlmrun_runtime_${suffix}`,
    ...identity,
    completedPrefixSnapshotId: `ctxsnap_runtime_${suffix}`,
    currentUserInputValueId: null,
    releaseIdentityDigest: digestB,
    fuelLimit: RLM_V2_MAX_FUEL,
    program,
    caller: parseRlmV2Caller({ ...callerValue, ...identity }),
  };
}

class MemoryValuePort implements RlmRuntimeEncryptedValuePort {
  readonly #byOperation = new Map<string, StoredValue>();
  readonly #byId = new Map<string, StoredValue>();
  readonly corruptOpenRoles = new Set<RlmRuntimeValueIdentity["role"]>();
  readonly sealInputs: unknown[] = [];

  sealJson(input: Parameters<RlmRuntimeEncryptedValuePort["sealJson"]>[0]) {
    this.sealInputs.push(input);
    const previous = this.#byOperation.get(input.operationId);
    if (previous !== undefined) {
      if (canonical(previous.input) !== canonical(input)) {
        throw new Error("immutable value conflict");
      }
      return Promise.resolve(previous.publication);
    }
    const valueId = `ctxval_${createHash("sha256")
      .update(input.operationId)
      .digest("base64url")
      .slice(0, 32)}`;
    const publication = {
      valueId,
      contentDigest: input.contentDigest,
      identityDigest: input.identityDigest,
    };
    const stored: StoredValue = {
      input: structuredClone(input),
      publication,
    };
    this.#byOperation.set(input.operationId, stored);
    this.#byId.set(valueId, stored);
    return Promise.resolve(publication);
  }

  openJson(input: Parameters<RlmRuntimeEncryptedValuePort["openJson"]>[0]) {
    const stored = this.#byId.get(input.valueId);
    if (stored === undefined) throw new Error("missing encrypted value");
    const publication = stored.publication;
    return Promise.resolve({
      ...publication,
      identityDigest: this.corruptOpenRoles.has(stored.input.identity.role)
        ? digestA === publication.identityDigest ? digestB : digestA
        : publication.identityDigest,
      value: structuredClone(stored.input.value),
    });
  }
}

interface StoredValue {
  readonly input: Parameters<RlmRuntimeEncryptedValuePort["sealJson"]>[0];
  readonly publication: Readonly<{
    valueId: string;
    contentDigest: string;
    identityDigest: string;
  }>;
}

class MemoryAuthority implements RlmRuntimeRunAuthorityPort {
  readonly runs = new Map<string, RlmRunRecord>();
  readonly receipts = new Map<string, RlmReceiptRecord>();
  readonly runTransitions: string[] = [];
  readonly receiptTransitions: string[] = [];
  readonly desiredTransitions: string[] = [];
  #clock = 0;

  prepareRun(input: Parameters<RlmRuntimeRunAuthorityPort["prepareRun"]>[0]) {
    const previous = this.runs.get(input.id);
    if (previous !== undefined) {
      if (!sameAdmission(previous, input)) throw new Error("run conflict");
      return previous;
    }
    const run: RlmRunRecord = {
      id: input.id,
      epochId: input.epochId,
      actorId: input.actorId,
      turnId: input.turnId,
      programValueId: input.programValueId,
      programDigest: input.programDigest,
      completedPrefixSnapshotId: input.completedPrefixSnapshotId,
      currentUserInputValueId: input.currentUserInputValueId,
      capabilities: [...input.capabilities].toSorted(),
      admittedFeatures: [...input.admittedFeatures].toSorted(),
      semanticWitnessDigests: [...input.semanticWitnessDigests].toSorted(),
      budget: input.budget,
      fuelLimit: input.fuelLimit,
      deadline: input.deadline,
      releaseIdentityDigest: input.releaseIdentityDigest,
      admissionDigest: input.admissionDigest,
      desiredState: "run",
      lifecycleCheckpoint: false,
      state: "prepared",
      terminalResultValueId: null,
      terminalCode: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      settledAt: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  transitionRun(input: Parameters<RlmRuntimeRunAuthorityPort["transitionRun"]>[0]) {
    const current = this.requireRun(input.runId);
    if (current.revision !== input.expectedRevision ||
        current.state !== input.expectedState) throw new Error("run cas");
    const terminal = input.nextState === "completed" || input.nextState === "failed" ||
      input.nextState === "stopped" || input.nextState === "recoveryRequired";
    const now = this.tick();
    const next: RlmRunRecord = {
      ...current,
      state: input.nextState,
      lifecycleCheckpoint: terminal ? false : current.lifecycleCheckpoint,
      terminalResultValueId: input.terminalResultValueId ?? null,
      terminalCode: input.terminalCode ?? null,
      revision: current.revision + 1,
      updatedAt: now,
      settledAt: terminal ? now : null,
    };
    this.runTransitions.push(`${current.state}->${next.state}`);
    this.runs.set(next.id, next);
    return next;
  }

  requestDesiredState(
    input: Parameters<RlmRuntimeRunAuthorityPort["requestDesiredState"]>[0],
  ) {
    const current = this.requireRun(input.runId);
    if (current.revision !== input.expectedRevision ||
        current.desiredState !== input.expectedDesiredState) throw new Error("intent cas");
    const next: RlmRunRecord = {
      ...current,
      desiredState: input.desiredState,
      lifecycleCheckpoint: false,
      revision: current.revision + 1,
      updatedAt: this.tick(),
    };
    this.desiredTransitions.push(`${current.desiredState}->${next.desiredState}`);
    this.runs.set(next.id, next);
    return next;
  }

  requestLifecycleCheckpoint(
    input: Parameters<
      RlmRuntimeRunAuthorityPort["requestLifecycleCheckpoint"]
    >[0],
  ) {
    const current = this.requireRun(input.runId);
    if (current.revision !== input.expectedRevision ||
        current.desiredState !== "run") throw new Error("checkpoint cas");
    const next: RlmRunRecord = {
      ...current,
      lifecycleCheckpoint: true,
      revision: current.revision + 1,
      updatedAt: this.tick(),
    };
    this.runs.set(next.id, next);
    return next;
  }

  releaseLifecycleCheckpoint(
    input: Parameters<
      RlmRuntimeRunAuthorityPort["releaseLifecycleCheckpoint"]
    >[0],
  ) {
    const current = this.requireRun(input.runId);
    if (current.revision !== input.expectedRevision ||
        !current.lifecycleCheckpoint) throw new Error("checkpoint cas");
    const next: RlmRunRecord = {
      ...current,
      lifecycleCheckpoint: false,
      revision: current.revision + 1,
      updatedAt: this.tick(),
    };
    this.runs.set(next.id, next);
    return next;
  }

  readRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  listRecoverableRuns(
    input: Parameters<RlmRuntimeRunAuthorityPort["listRecoverableRuns"]>[0],
  ) {
    return [...this.runs.values()]
      .filter((run) => ["prepared", "running", "suspended", "recoveryRequired"]
        .includes(run.state))
      .filter((run) => input.afterRunId === null || input.afterRunId === undefined ||
        run.id > input.afterRunId)
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }

  prepareReceipt(
    input: Parameters<RlmRuntimeRunAuthorityPort["prepareReceipt"]>[0],
  ) {
    const previous = this.receipts.get(input.id);
    if (previous !== undefined) {
      if (previous.runId !== input.runId || previous.operation !== input.operation ||
          previous.requestDigest !== input.requestDigest ||
          previous.effectKey !== input.effectKey ||
          canonical(previous.nodePath) !== canonical(input.nodePath)) {
        throw new Error("receipt conflict");
      }
      return previous;
    }
    const replayClass = replayClassFor(input.operation);
    const receipt: RlmReceiptRecord = {
      id: input.id,
      runId: input.runId,
      nodePath: input.nodePath,
      operation: input.operation,
      requestDigest: input.requestDigest,
      effectKey: input.effectKey,
      replayClass,
      state: "prepared",
      resultValueId: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
      settledAt: null,
    };
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  transitionReceipt(
    input: Parameters<RlmRuntimeRunAuthorityPort["transitionReceipt"]>[0],
  ) {
    const current = this.receipts.get(input.receiptId);
    if (current === undefined || current.state !== input.expectedState) {
      throw new Error("receipt cas");
    }
    const terminal = input.nextState === "succeeded" || input.nextState === "failed" ||
      input.nextState === "recoveryRequired";
    const now = this.tick();
    const next: RlmReceiptRecord = {
      ...current,
      state: input.nextState,
      resultValueId: input.resultValueId ?? null,
      error: input.error ?? null,
      updatedAt: now,
      settledAt: terminal ? now : null,
    };
    this.receiptTransitions.push(`${current.replayClass}:${current.state}->${next.state}`);
    this.receipts.set(next.id, next);
    return next;
  }

  readReceipt(receiptId: string) {
    return this.receipts.get(receiptId) ?? null;
  }

  listRecoverableReceipts(
    input: Parameters<RlmRuntimeRunAuthorityPort["listRecoverableReceipts"]>[0],
  ) {
    return [...this.receipts.values()]
      .filter((receipt) => [
        "prepared",
        "effectStarted",
        "replayRequired",
        "recoveryRequired",
      ].includes(receipt.state))
      .filter((receipt) =>
        input.afterReceiptId === null || input.afterReceiptId === undefined ||
        receipt.id > input.afterReceiptId
      )
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }

  reopen(
    runId: string,
    state: RlmRunRecord["state"],
    desiredState: RlmRunRecord["desiredState"] = "run",
    lifecycleCheckpoint = false,
  ) {
    const current = this.requireRun(runId);
    const next: RlmRunRecord = {
      ...current,
      state,
      desiredState,
      lifecycleCheckpoint,
      terminalResultValueId: null,
      terminalCode: null,
      settledAt: null,
      revision: current.revision + 1,
      updatedAt: this.tick(),
    };
    this.runs.set(runId, next);
    return next;
  }

  ledgerText(): string {
    return canonical({
      runs: [...this.runs.values()],
      receipts: [...this.receipts.values()],
    });
  }

  requireRun(runId: string): RlmRunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error("missing run");
    return run;
  }

  tick(): string {
    this.#clock += 1;
    return new Date(Date.parse(createdAt) + this.#clock * 1_000).toISOString();
  }
}

class ReconciliationRaceAuthority extends MemoryAuthority {
  #raceNextReplayTransition = false;

  raceNextReplayTransition(): void {
    this.#raceNextReplayTransition = true;
  }

  override transitionReceipt(
    input: Parameters<RlmRuntimeRunAuthorityPort["transitionReceipt"]>[0],
  ) {
    if (
      this.#raceNextReplayTransition &&
      input.expectedState === "effectStarted" &&
      input.nextState === "replayRequired"
    ) {
      this.#raceNextReplayTransition = false;
      super.transitionReceipt(input);
      throw new Error("receipt cas");
    }
    return super.transitionReceipt(input);
  }
}

function replayClassFor(operation: RlmV2Operation): RlmReceiptRecord["replayClass"] {
  if (operation === "agent.waitAny" || operation === "agent.waitAll") {
    return "cancelableWait";
  }
  if (operation === "context.materialize" || operation === "heap.put" ||
      operation === "agent.result" || operation === "harness.propose") {
    return "idempotentLocalMutation";
  }
  if (operation === "agent.spawn" || operation === "agent.send" ||
      operation === "agent.cancel") return "reconciledExternalMutation";
  return "pureRead";
}

function sameAdmission(
  run: RlmRunRecord,
  input: Parameters<RlmRuntimeRunAuthorityPort["prepareRun"]>[0],
): boolean {
  return canonical({
    id: run.id,
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    programValueId: run.programValueId,
    programDigest: run.programDigest,
    completedPrefixSnapshotId: run.completedPrefixSnapshotId,
    currentUserInputValueId: run.currentUserInputValueId,
    capabilities: run.capabilities,
    admittedFeatures: run.admittedFeatures,
    semanticWitnessDigests: run.semanticWitnessDigests,
    budget: run.budget,
    fuelLimit: run.fuelLimit,
    deadline: run.deadline,
    releaseIdentityDigest: run.releaseIdentityDigest,
    admissionDigest: run.admissionDigest,
  }) === canonical({
    ...input,
    capabilities: [...input.capabilities].toSorted(),
    admittedFeatures: [...input.admittedFeatures].toSorted(),
    semanticWitnessDigests: [...input.semanticWitnessDigests].toSorted(),
  });
}

function fixture(input: Readonly<{
  operation?: RlmV2OperationPort;
  pageLimit?: number;
  authority?: MemoryAuthority;
  values?: MemoryValuePort;
  callers?: RlmRuntimeCallerPort;
}> = {}) {
  const authority = input.authority ?? new MemoryAuthority();
  const values = input.values ?? new MemoryValuePort();
  const callerByRun = new Map<string, unknown>();
  const callers: RlmRuntimeCallerPort = input.callers ?? {
    resolveCaller(run) {
      const value = callerByRun.get(run.id);
      if (value === undefined) throw new Error("caller unavailable");
      return Promise.resolve(value);
    },
  };
  const operation = input.operation ?? {
    invoke() {
      return Promise.resolve({ ok: true });
    },
  };
  const runtime = new RlmRuntimeV2({
    authority,
    values,
    callers,
    operations: operation,
    ...(input.pageLimit === undefined ? {} : { pageLimit: input.pageLimit }),
    pollIntervalMs: 1,
  });
  return {
    authority,
    values,
    callerByRun,
    runtime,
    async admit(inputValue: RlmRuntimeAdmission) {
      callerByRun.set(inputValue.runId, inputValue.caller);
      return await runtime.admit(inputValue);
    },
  };
}

async function eventually<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("eventually timed out");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

describe("RLM v2 durable runtime", () => {
  test("admits durably before scheduling and stores plaintext only through the encrypted port", async () => {
    const operationCalls: unknown[] = [];
    const value = fixture({
      operation: {
        invoke(operation, argumentsValue, context) {
          operationCalls.push({ operation, argumentsValue, receiptId: context.receiptId });
          return Promise.resolve({ privateResult: "encrypted-result-only" });
        },
      },
    });
    const input = admission("00000001", callProgram("context.snapshot"));
    const handle = await value.admit(input);
    expect(handle).toMatchObject({
      runId: input.runId,
      state: "prepared",
      desiredState: "run",
      revision: 1,
    });

    const terminal = await value.runtime.wait(input.runId, 2_000);
    expect(terminal.state).toBe("completed");
    expect(await value.runtime.result(input.runId)).toEqual({
      state: "completed",
      value: { privateResult: "encrypted-result-only" },
    });
    expect(operationCalls).toHaveLength(1);
    expect(value.authority.receiptTransitions).toEqual([
      "pureRead:prepared->effectStarted",
      "pureRead:effectStarted->succeeded",
    ]);
    expect(value.authority.ledgerText()).not.toContain("encrypted-result-only");
    expect(value.authority.ledgerText()).not.toContain("thread_runtime_root_0001");
    expect(value.values.sealInputs).toHaveLength(3);
  });

  test("replays one stable actor run across two provider incarnations without repeating effects", async () => {
    let calls = 0;
    let providerGeneration = 7;
    const resolvedProviderGenerations: number[] = [];
    const input = admission("00000002", callProgram("context.snapshot"));
    const stableCaller = input.caller;
    const callers: RlmRuntimeCallerPort = {
      resolveCaller() {
        resolvedProviderGenerations.push(providerGeneration);
        return Promise.resolve(stableCaller);
      },
    };
    const value = fixture({
      operation: {
        invoke() {
          calls += 1;
          return Promise.resolve({ sequence: calls });
        },
      },
      pageLimit: 1,
      callers,
    });
    await value.admit(input);
    await value.runtime.wait(input.runId, 2_000);
    expect(calls).toBe(1);

    value.authority.reopen(input.runId, "running");
    providerGeneration = 8;
    const restarted = new RlmRuntimeV2({
      authority: value.authority,
      values: value.values,
      callers,
      operations: {
        invoke() {
          calls += 1;
          return Promise.resolve({ sequence: calls });
        },
      },
      pageLimit: 1,
      pollIntervalMs: 1,
    });
    const boot = await restarted.reconcileOnBoot();
    expect(boot.scheduledRunIds).toEqual([input.runId]);
    await restarted.wait(input.runId, 2_000);
    expect(calls).toBe(1);
    expect(await restarted.result(input.runId)).toEqual({
      state: "completed",
      value: { sequence: 1 },
    });
    expect(resolvedProviderGenerations).toEqual([7, 8]);
  });

  test("reconciles every replay class after a crash at effectStarted", async () => {
    const representatives = [
      "context.snapshot",
      "agent.waitAny",
      "heap.put",
      "agent.spawn",
    ] as const;
    for (const [index, operation] of representatives.entries()) {
      const authority = new MemoryAuthority();
      const values = new MemoryValuePort();
      const never = new Promise<unknown>(() => undefined);
      const first = fixture({
        authority,
        values,
        operation: { invoke: () => never },
        pageLimit: 1,
      });
      const input = admission(`replay000${index}`, callProgram(operation));
      await first.admit(input);
      const receipt = await eventually(() =>
        [...authority.receipts.values()].find((entry) =>
          entry.runId === input.runId && entry.state === "effectStarted"
        ) ?? null
      );
      expect(receipt.replayClass).toBe(replayClassFor(operation));

      let replayCalls = 0;
      const restarted = new RlmRuntimeV2({
        authority,
        values,
        callers: { resolveCaller: () => Promise.resolve(input.caller) },
        operations: {
          invoke() {
            replayCalls += 1;
            return Promise.resolve({ reconciled: operation });
          },
        },
        pageLimit: 1,
        pollIntervalMs: 1,
      });
      const report = await restarted.reconcileOnBoot();
      expect(report.replayPreparedReceiptIds).toEqual([receipt.id]);
      await restarted.wait(input.runId, 2_000);
      expect(replayCalls).toBe(1);
      expect(authority.receipts.get(receipt.id)?.state).toBe("succeeded");
    }
  });

  test("suspends response-lost external mutations and replays one receipt after restart", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const receiptIds: string[] = [];
    const input = admission("external_replay01", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke(_operation, _argumentsValue, context) {
          receiptIds.push(context.receiptId);
          return Promise.reject(new RlmV2OperationReplayRequiredError());
        },
      },
    });
    await first.admit(input);
    const suspended = await eventually(() => {
      const run = authority.requireRun(input.runId);
      return run.state === "suspended" ? run : null;
    });
    expect(suspended.desiredState).toBe("run");
    const receipt = [...authority.receipts.values()].find(
      (entry) => entry.runId === input.runId,
    );
    if (receipt === undefined) throw new Error("missing external receipt");
    expect(receipt).toMatchObject({
      replayClass: "reconciledExternalMutation",
      state: "replayRequired",
      resultValueId: null,
      error: null,
      settledAt: null,
    });
    expect(authority.runTransitions).toContain("running->suspended");
    expect(authority.receiptTransitions).not.toContain(
      "reconciledExternalMutation:effectStarted->failed",
    );

    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke(_operation, _argumentsValue, context) {
          receiptIds.push(context.receiptId);
          return Promise.resolve({ actorId: "hactor_reconciled_child01" });
        },
      },
      pageLimit: 1,
      pollIntervalMs: 1,
    });
    const report = await restarted.reconcileOnBoot();
    expect(report.scheduledRunIds).toEqual([input.runId]);
    expect((await restarted.wait(input.runId, 2_000)).state).toBe("completed");
    expect(receiptIds).toEqual([receipt.id, receipt.id]);
    expect(authority.receipts.get(receipt.id)?.state).toBe("succeeded");
  });

  test("stops before effect admission without starting or draining an operation", async () => {
    let releaseCaller: () => void = () => undefined;
    const callerGate = new Promise<void>((resolve) => {
      releaseCaller = resolve;
    });
    let operationCalls = 0;
    const input = admission("stop_before_admit", callProgram("agent.spawn"));
    const value = fixture({
      callers: {
        async resolveCaller() {
          await callerGate;
          return input.caller;
        },
      },
      operation: {
        invoke() {
          operationCalls += 1;
          return Promise.resolve({ unexpected: true });
        },
      },
    });
    await value.admit(input);
    await eventually(() =>
      value.authority.requireRun(input.runId).state === "running" ? true : null
    );
    const stopping = value.runtime.stop(input.runId);
    await eventually(() =>
      value.authority.requireRun(input.runId).desiredState === "stop"
        ? true
        : null
    );
    releaseCaller();
    await stopping;
    const stopped = await eventually(() => {
      const run = value.authority.requireRun(input.runId);
      return run.state === "stopped" ? run : null;
    });

    expect(stopped.desiredState).toBe("stop");
    expect(operationCalls).toBe(0);
    expect(value.authority.receipts.size).toBe(0);
  });

  test("stop drains one accepted response-lost effect and starts no new receipt", async () => {
    const receiptIds: string[] = [];
    let calls = 0;
    const value = fixture({
      operation: {
        invoke(_operation, _argumentsValue, context) {
          calls += 1;
          receiptIds.push(context.receiptId);
          if (calls > 1) return Promise.resolve({ reconciled: true });
          return new Promise((_resolve, reject) => {
            const loseResponse = () => reject(
              new RlmV2OperationReplayRequiredError(),
            );
            if (context.signal.aborted) loseResponse();
            else context.signal.addEventListener("abort", loseResponse, {
              once: true,
            });
          });
        },
      },
    });
    const input = admission("stop_drain_success", callProgram("agent.spawn"));
    await value.admit(input);
    const admittedReceipt = await eventually(() =>
      [...value.authority.receipts.values()].find(
        (receipt) => receipt.state === "effectStarted",
      ) ?? null
    );
    await value.runtime.stop(input.runId);
    const stopped = await eventually(() => {
      const run = value.authority.requireRun(input.runId);
      return run.state === "stopped" ? run : null;
    });

    expect(stopped.desiredState).toBe("stop");
    expect(receiptIds).toEqual([admittedReceipt.id, admittedReceipt.id]);
    expect(value.authority.receipts.size).toBe(1);
    expect(value.authority.receipts.get(admittedReceipt.id)?.state)
      .toBe("succeeded");
    expect(value.authority.runTransitions).toContain("running->suspended");
    expect(value.authority.runTransitions).toContain("suspended->running");
    expect(value.authority.runTransitions.at(-1)).toBe("running->stopped");
  });

  test("restart during stop drain replays the exact debt once and then stops", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const input = admission("stop_drain_restart", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke() {
          return Promise.reject(new RlmV2OperationReplayRequiredError());
        },
      },
    });
    await first.admit(input);
    const suspended = await eventually(() => {
      const run = authority.requireRun(input.runId);
      return run.state === "suspended" ? run : null;
    });
    authority.requestDesiredState({
      runId: suspended.id,
      expectedRevision: suspended.revision,
      expectedDesiredState: "run",
      desiredState: "stop",
    });
    const receipt = [...authority.receipts.values()][0];
    if (receipt === undefined) throw new Error("missing drain receipt");

    let drainCalls = 0;
    const draining = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke(_operation, _argumentsValue, context) {
          drainCalls += 1;
          expect(context.receiptId).toBe(receipt.id);
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(
              new RlmV2OperationReplayRequiredError(),
            ), { once: true });
          });
        },
      },
      pollIntervalMs: 1,
    });
    expect((await draining.reconcileOnBoot()).scheduledRunIds)
      .toEqual([input.runId]);
    await eventually(() =>
      authority.receipts.get(receipt.id)?.state === "effectStarted" ? true : null
    );
    await draining.quiesce(2_000);
    expect(authority.requireRun(input.runId)).toMatchObject({
      state: "suspended",
      desiredState: "stop",
    });
    expect(authority.receipts.get(receipt.id)?.state).toBe("replayRequired");

    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke(_operation, _argumentsValue, context) {
          drainCalls += 1;
          expect(context.receiptId).toBe(receipt.id);
          return Promise.resolve({ reconciled: true });
        },
      },
      pollIntervalMs: 1,
    });
    expect((await restarted.reconcileOnBoot()).scheduledRunIds)
      .toEqual([input.runId]);
    await eventually(() =>
      authority.requireRun(input.runId).state === "stopped" ? true : null
    );
    expect(drainCalls).toBe(2);
    expect(authority.receipts.size).toBe(1);
    expect(authority.receipts.get(receipt.id)?.state).toBe("succeeded");
  });

  test("boot closes a suspended stop after its receipt settled before run CAS", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const input = admission("stop_drain_settled", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
      },
    });
    await first.admit(input);
    const suspended = await eventually(() => {
      const run = authority.requireRun(input.runId);
      return run.state === "suspended" ? run : null;
    });
    authority.requestDesiredState({
      runId: suspended.id,
      expectedRevision: suspended.revision,
      expectedDesiredState: "run",
      desiredState: "stop",
    });
    const receipt = [...authority.receipts.values()][0];
    if (receipt === undefined) throw new Error("missing settled drain receipt");
    authority.transitionReceipt({
      receiptId: receipt.id,
      expectedState: "replayRequired",
      nextState: "effectStarted",
    });
    authority.transitionReceipt({
      receiptId: receipt.id,
      expectedState: "effectStarted",
      nextState: "failed",
      error: { code: "provider_rejected", retryable: false },
    });
    let calls = 0;
    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke() {
          calls += 1;
          return Promise.resolve(null);
        },
      },
      pollIntervalMs: 1,
    });
    const report = await restarted.reconcileOnBoot();

    expect(report.stoppedRunIds).toEqual([input.runId]);
    expect(report.scheduledRunIds).toEqual([]);
    expect(authority.requireRun(input.runId).state).toBe("stopped");
    expect(calls).toBe(0);
  });

  test("conflicting stop-drain evidence fails closed without provider invocation", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const input = admission("stop_drain_conflict", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
      },
    });
    await first.admit(input);
    const suspended = await eventually(() => {
      const run = authority.requireRun(input.runId);
      return run.state === "suspended" ? run : null;
    });
    authority.requestDesiredState({
      runId: suspended.id,
      expectedRevision: suspended.revision,
      expectedDesiredState: "run",
      desiredState: "stop",
    });
    const receipt = [...authority.receipts.values()][0];
    if (receipt === undefined) throw new Error("missing conflicting receipt");
    authority.receipts.set(receipt.id, {
      ...receipt,
      requestDigest: digestB,
    });
    let calls = 0;
    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke() {
          calls += 1;
          return Promise.resolve({ forbidden: true });
        },
      },
      pollIntervalMs: 1,
    });
    await restarted.reconcileOnBoot();
    await eventually(() =>
      authority.requireRun(input.runId).state === "recoveryRequired"
        ? true
        : null
    );

    expect(calls).toBe(0);
    expect(authority.receipts.size).toBe(1);
    expect(authority.receipts.get(receipt.id)?.state).toBe("replayRequired");
  });

  test("receipt reconciliation accepts an identical replay transition that won the CAS", async () => {
    const authority = new ReconciliationRaceAuthority();
    const values = new MemoryValuePort();
    const input = admission("stop_drain_cas", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
      },
    });
    await first.admit(input);
    await eventually(() =>
      authority.requireRun(input.runId).state === "suspended" ? true : null
    );
    const receipt = [...authority.receipts.values()][0];
    if (receipt === undefined) throw new Error("missing racing receipt");
    authority.transitionReceipt({
      receiptId: receipt.id,
      expectedState: "replayRequired",
      nextState: "effectStarted",
    });
    authority.raceNextReplayTransition();
    let calls = 0;
    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke() {
          calls += 1;
          return Promise.resolve({ reconciled: true });
        },
      },
      pollIntervalMs: 1,
    });

    await restarted.resume(input.runId);
    await eventually(() =>
      authority.requireRun(input.runId).state === "completed" ? true : null
    );

    expect(calls).toBe(1);
    expect(authority.receipts.size).toBe(1);
    expect(authority.receipts.get(receipt.id)?.state).toBe("succeeded");
    expect(authority.requireRun(input.runId).state).toBe("completed");
  });

  test("boot rejects orphaned external debt before mutating or invoking", async () => {
    const cases = [
      { receiptState: "effectStarted", parent: "stopped" },
      { receiptState: "replayRequired", parent: "stopped" },
      { receiptState: "recoveryRequired", parent: "stopped" },
      { receiptState: "effectStarted", parent: "missing" },
      { receiptState: "replayRequired", parent: "missing" },
      { receiptState: "recoveryRequired", parent: "missing" },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const authority = new MemoryAuthority();
      const values = new MemoryValuePort();
      const input = admission(
        `stop_drain_orphan_${index}`,
        callProgram("agent.spawn"),
      );
      const first = fixture({
        authority,
        values,
        operation: {
          invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
        },
      });
      await first.admit(input);
      await eventually(() =>
        authority.requireRun(input.runId).state === "suspended" ? true : null
      );
      const receipt = [...authority.receipts.values()][0];
      if (receipt === undefined) throw new Error("missing orphan receipt");
      if (testCase.receiptState === "effectStarted") {
        authority.transitionReceipt({
          receiptId: receipt.id,
          expectedState: "replayRequired",
          nextState: "effectStarted",
        });
      } else if (testCase.receiptState === "recoveryRequired") {
        authority.transitionReceipt({
          receiptId: receipt.id,
          expectedState: "replayRequired",
          nextState: "recoveryRequired",
          error: { code: "ambiguous_external_effect", retryable: false },
        });
      }
      if (testCase.parent === "missing") {
        authority.runs.delete(input.runId);
      } else {
        const run = authority.requireRun(input.runId);
        const settledAt = authority.tick();
        authority.runs.set(run.id, {
          ...run,
          desiredState: "stop",
          state: "stopped",
          terminalCode: "stopped",
          revision: run.revision + 1,
          updatedAt: settledAt,
          settledAt,
        });
      }
      let calls = 0;
      const restarted = new RlmRuntimeV2({
        authority,
        values,
        callers: { resolveCaller: () => Promise.resolve(input.caller) },
        operations: {
          invoke() {
            calls += 1;
            return Promise.resolve({ forbidden: true });
          },
        },
        pollIntervalMs: 1,
      });

      let bootError: unknown = null;
      try {
        await restarted.reconcileOnBoot();
      } catch (cause: unknown) {
        bootError = cause;
      }
      expect(bootError).toMatchObject({
        code: "corrupt_state",
      });
      expect(calls).toBe(0);
      expect(authority.receipts.get(receipt.id)?.state)
        .toBe(testCase.receiptState);
    }
  });

  test("boot accepts a coherently terminal external recovery pair", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const input = admission("stop_drain_recovery_pair", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
      },
    });
    await first.admit(input);
    await eventually(() =>
      authority.requireRun(input.runId).state === "suspended" ? true : null
    );
    const receipt = [...authority.receipts.values()][0];
    if (receipt === undefined) throw new Error("missing recovery receipt");
    authority.transitionReceipt({
      receiptId: receipt.id,
      expectedState: "replayRequired",
      nextState: "recoveryRequired",
      error: { code: "ambiguous_external_effect", retryable: false },
    });
    const run = authority.requireRun(input.runId);
    const settledAt = authority.tick();
    authority.runs.set(run.id, {
      ...run,
      state: "recoveryRequired",
      terminalCode: "recovery_required",
      revision: run.revision + 1,
      updatedAt: settledAt,
      settledAt,
    });
    let calls = 0;
    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke() {
          calls += 1;
          return Promise.resolve({ forbidden: true });
        },
      },
      pollIntervalMs: 1,
    });

    const report = await restarted.reconcileOnBoot();

    expect(report.recoveryRequiredRunIds).toEqual([input.runId]);
    expect(report.scheduledRunIds).toEqual([]);
    expect(calls).toBe(0);
    expect(authority.receipts.get(receipt.id)?.state).toBe("recoveryRequired");
  });

  test("failed and repeatedly uncertain drains resolve without duplicate admission", async () => {
    for (const terminal of ["failed", "succeeded"] as const) {
      const authority = new MemoryAuthority();
      const values = new MemoryValuePort();
      const input = admission(`stop_drain_${terminal}`, callProgram("agent.spawn"));
      const first = fixture({
        authority,
        values,
        operation: {
          invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
        },
      });
      await first.admit(input);
      const suspended = await eventually(() => {
        const run = authority.requireRun(input.runId);
        return run.state === "suspended" ? run : null;
      });
      authority.requestDesiredState({
        runId: suspended.id,
        expectedRevision: suspended.revision,
        expectedDesiredState: "run",
        desiredState: "stop",
      });
      const receipt = [...authority.receipts.values()][0];
      if (receipt === undefined) throw new Error("missing drain receipt");
      let calls = 0;
      const runtime = new RlmRuntimeV2({
        authority,
        values,
        callers: { resolveCaller: () => Promise.resolve(input.caller) },
        operations: {
          invoke() {
            calls += 1;
            if (calls === 1) {
              return Promise.reject(new RlmV2OperationReplayRequiredError());
            }
            return terminal === "failed"
              ? Promise.reject(new Error("definitive rejection"))
              : Promise.resolve({ reconciled: true });
          },
        },
        pollIntervalMs: 1,
      });

      await runtime.reconcileOnBoot();
      await eventually(() => calls === 1 ? true : null);
      expect(authority.requireRun(input.runId).state).toBe("suspended");
      expect(calls).toBe(1);
      await runtime.reconcileOnBoot();
      await runtime.reconcileOnBoot();
      await eventually(() =>
        authority.requireRun(input.runId).state === "stopped" ? true : null
      );
      expect(calls).toBe(2);
      expect(authority.receipts.size).toBe(1);
      expect(authority.receipts.get(receipt.id)?.state).toBe(terminal);
    }
  });

  test("repeated stop leaves one active drain attempt undisturbed", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const input = admission("stop_drain_repeat", callProgram("agent.spawn"));
    const first = fixture({
      authority,
      values,
      operation: {
        invoke: () => Promise.reject(new RlmV2OperationReplayRequiredError()),
      },
    });
    await first.admit(input);
    await eventually(() =>
      authority.requireRun(input.runId).state === "suspended" ? true : null
    );
    let resolveDrain: (value: unknown) => void = () => undefined;
    const drainResult = new Promise<unknown>((resolve) => {
      resolveDrain = resolve;
    });
    let calls = 0;
    const runtime = new RlmRuntimeV2({
      authority,
      values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: {
        invoke() {
          calls += 1;
          return drainResult;
        },
      },
      pollIntervalMs: 1,
    });

    await runtime.stop(input.runId);
    await eventually(() => calls === 1 ? true : null);
    await runtime.stop(input.runId);
    expect(calls).toBe(1);
    resolveDrain({ reconciled: true });
    await eventually(() =>
      authority.requireRun(input.runId).state === "stopped" ? true : null
    );
    expect(calls).toBe(1);
    expect(authority.receipts.size).toBe(1);
  });

  test("property: stop-drain histories never create or invoke a second receipt", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("replayRequired", "failed", "succeeded"), {
        minLength: 1,
        maxLength: 5,
      }),
      async (outcomes) => {
        const authority = new MemoryAuthority();
        const values = new MemoryValuePort();
        const input = admission("stop_drain_property", callProgram("agent.spawn"));
        const first = fixture({
          authority,
          values,
          operation: {
            invoke: () => Promise.reject(
              new RlmV2OperationReplayRequiredError(),
            ),
          },
        });
        await first.admit(input);
        const suspended = await eventually(() => {
          const run = authority.requireRun(input.runId);
          return run.state === "suspended" ? run : null;
        });
        authority.requestDesiredState({
          runId: suspended.id,
          expectedRevision: suspended.revision,
          expectedDesiredState: "run",
          desiredState: "stop",
        });
        const receipt = [...authority.receipts.values()][0];
        if (receipt === undefined) throw new Error("missing property receipt");

        const invokedReceiptIds: string[] = [];
        let outcomeIndex = 0;
        const runtime = new RlmRuntimeV2({
          authority,
          values,
          callers: { resolveCaller: () => Promise.resolve(input.caller) },
          operations: {
            invoke(_operation, _argumentsValue, context) {
              invokedReceiptIds.push(context.receiptId);
              const outcome = outcomes[outcomeIndex++] ?? "replayRequired";
              if (outcome === "replayRequired") {
                return Promise.reject(new RlmV2OperationReplayRequiredError());
              }
              if (outcome === "failed") {
                return Promise.reject(new Error("definitive rejection"));
              }
              return Promise.resolve({ reconciled: true });
            },
          },
          pageLimit: 1,
          pollIntervalMs: 1,
        });

        let terminal = false;
        for (const outcome of outcomes) {
          if (terminal) break;
          const priorCalls = invokedReceiptIds.length;
          await runtime.reconcileOnBoot();
          if (outcome === "replayRequired") {
            await eventually(() => {
              const run = authority.requireRun(input.runId);
              return invokedReceiptIds.length === priorCalls + 1 &&
                  run.state === "suspended" &&
                  authority.receipts.get(receipt.id)?.state === "replayRequired"
                ? true
                : null;
            });
          } else {
            await eventually(() =>
              authority.requireRun(input.runId).state === "stopped" ? true : null
            );
            expect(authority.receipts.get(receipt.id)?.state).toBe(outcome);
            terminal = true;
          }
          expect(authority.receipts.size).toBe(1);
          expect(invokedReceiptIds).toEqual(
            Array.from({ length: invokedReceiptIds.length }, () => receipt.id),
          );
        }

        if (terminal) {
          const calls = invokedReceiptIds.length;
          await runtime.reconcileOnBoot();
          await runtime.reconcileOnBoot();
          expect(invokedReceiptIds).toHaveLength(calls);
          expect(authority.requireRun(input.runId).state).toBe("stopped");
        } else {
          expect(authority.requireRun(input.runId)).toMatchObject({
            state: "suspended",
            desiredState: "stop",
          });
          expect(authority.receipts.get(receipt.id)?.state)
            .toBe("replayRequired");
        }
      },
    ), { numRuns: 50 });
  }, PROPERTY_TIMEOUT);

  test("enumerates all pages, leaves suspended runs suspended, and surfaces recovery", async () => {
    const authority = new MemoryAuthority();
    const values = new MemoryValuePort();
    const value = fixture({ authority, values, pageLimit: 1 });
    const prepared = admission("page0001", literalProgram({ run: 1 }), caller([]));
    const suspended = admission("page0002", literalProgram({ run: 2 }), caller([]));
    const recovery = admission("page0003", callProgram("context.snapshot"));
    await value.admit(prepared);
    await value.admit(suspended);
    await value.admit(recovery);
    await value.runtime.wait(prepared.runId, 2_000);
    await value.runtime.wait(suspended.runId, 2_000);
    await value.runtime.wait(recovery.runId, 2_000);
    authority.reopen(prepared.runId, "prepared");
    authority.reopen(suspended.runId, "suspended", "suspend");
    authority.reopen(recovery.runId, "running");
    const recoveryReceipt = [...authority.receipts.values()].find((receipt) =>
      receipt.runId === recovery.runId
    );
    if (recoveryReceipt === undefined) throw new Error("missing receipt");
    authority.receipts.set(recoveryReceipt.id, {
      ...recoveryReceipt,
      state: "recoveryRequired",
      resultValueId: null,
      error: { code: "ambiguous_effect", retryable: false },
      settledAt: authority.tick(),
      updatedAt: authority.tick(),
    });

    const restarted = new RlmRuntimeV2({
      authority,
      values,
      callers: {
        resolveCaller(run) {
          const matching = [prepared, suspended, recovery]
            .find((entry) => entry.runId === run.id);
          if (matching === undefined) throw new Error("missing caller");
          return Promise.resolve(matching.caller);
        },
      },
      operations: { invoke: () => Promise.resolve({ ok: true }) },
      pageLimit: 1,
      pollIntervalMs: 1,
    });
    const report = await restarted.reconcileOnBoot();
    expect(report.scheduledRunIds).toEqual([prepared.runId]);
    expect(report.suspendedRunIds).toEqual([suspended.runId]);
    expect(report.recoveryRequiredRunIds).toEqual([recovery.runId]);
    expect((await restarted.status(suspended.runId)).state).toBe("suspended");
    expect((await restarted.status(recovery.runId)).state).toBe("recoveryRequired");
    await restarted.wait(prepared.runId, 2_000);
  });

  test("suspends durably, aborts a cancellable operation, and resumes from its receipt", async () => {
    let calls = 0;
    const value = fixture({
      operation: {
        invoke(_operation, _argumentsValue, context) {
          calls += 1;
          if (calls > 1) return Promise.resolve({ resumed: true });
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      },
    });
    const input = admission("suspend01", callProgram("agent.waitAny"));
    await value.admit(input);
    await eventually(() => calls === 1 ? true : null);
    const suspended = await value.runtime.suspend(input.runId);
    expect(suspended).toMatchObject({ state: "suspended", desiredState: "suspend" });
    expect(value.authority.desiredTransitions).toContain("run->suspend");
    await value.runtime.resume(input.runId);
    const terminal = await value.runtime.wait(input.runId, 2_000);
    expect(terminal.state).toBe("completed");
    expect(calls).toBe(2);
  });

  test("quiesce checkpoints run intent for restart without resuming explicit suspension", async () => {
    const resumable = admission(
      "quiesce_restart01",
      callProgram("agent.waitAny"),
    );
    const explicitlySuspended = admission(
      "quiesce_explicit01",
      callProgram("agent.waitAny"),
    );
    const calls = new Map<string, number>();
    const operations: RlmV2OperationPort = {
      invoke(_operation, _argumentsValue, context) {
        const count = (calls.get(context.programRunId) ?? 0) + 1;
        calls.set(context.programRunId, count);
        if (context.programRunId === resumable.runId && count === 2) {
          return Promise.resolve({ resumed: true });
        }
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new Error("aborted"));
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const value = fixture({ operation: operations });
    await value.admit(resumable);
    await value.admit(explicitlySuspended);
    await eventually(() => calls.size === 2 ? true : null);

    expect(await value.runtime.suspend(explicitlySuspended.runId)).toMatchObject({
      state: "suspended",
      desiredState: "suspend",
    });
    const report = await value.runtime.quiesce(2_000);
    expect(report).toEqual({
      requestedRunIds: [explicitlySuspended.runId, resumable.runId],
      settledRunIds: [explicitlySuspended.runId, resumable.runId],
      timedOutRunIds: [],
    });
    expect(value.authority.requireRun(resumable.runId)).toMatchObject({
      state: "suspended",
      desiredState: "run",
      lifecycleCheckpoint: true,
    });
    expect(value.authority.requireRun(explicitlySuspended.runId)).toMatchObject({
      state: "suspended",
      desiredState: "suspend",
      lifecycleCheckpoint: false,
    });
    expect(value.runtime.resume(explicitlySuspended.runId)).rejects
      .toMatchObject({ code: "quiesced" });

    const restarted = new RlmRuntimeV2({
      authority: value.authority,
      values: value.values,
      callers: {
        resolveCaller(run) {
          const callerValue = value.callerByRun.get(run.id);
          if (callerValue === undefined) throw new Error("caller unavailable");
          return Promise.resolve(callerValue);
        },
      },
      operations,
      pageLimit: 1,
      pollIntervalMs: 1,
    });
    const boot = await restarted.reconcileOnBoot();
    expect(boot.scheduledRunIds).toEqual([resumable.runId]);
    expect(boot.suspendedRunIds).toEqual([explicitlySuspended.runId]);
    expect((await restarted.wait(resumable.runId, 2_000)).state)
      .toBe("completed");
    expect(calls.get(resumable.runId)).toBe(2);
    expect(calls.get(explicitlySuspended.runId)).toBe(1);
    expect(await restarted.status(explicitlySuspended.runId)).toMatchObject({
      state: "suspended",
      desiredState: "suspend",
    });
  });

  test("quiesce persists a resumable checkpoint before abort and repeats timeouts", async () => {
    let aborted = false;
    const value = fixture({
      operation: {
        invoke(_operation, _argumentsValue, context) {
          context.signal.addEventListener("abort", () => {
            aborted = true;
          }, { once: true });
          return new Promise(() => undefined);
        },
      },
    });
    const input = admission("quiesce01", callProgram("context.snapshot"));
    await value.admit(input);
    await eventually(() => value.authority.receipts.size === 1 ? true : null);
    const report = await value.runtime.quiesce(1);
    expect(aborted).toBeTrue();
    expect(value.authority.requireRun(input.runId)).toMatchObject({
      state: "running",
      desiredState: "run",
      lifecycleCheckpoint: true,
    });
    expect(value.authority.desiredTransitions).toEqual([]);
    expect(report.requestedRunIds).toEqual([input.runId]);
    expect(report.timedOutRunIds).toEqual([input.runId]);
    expect(await value.runtime.quiesce(1)).toEqual({
      requestedRunIds: [input.runId],
      settledRunIds: [],
      timedOutRunIds: [input.runId],
    });
    expect(value.runtime.admit(admission(
      "quiesce02",
      literalProgram(),
      caller([]),
    ))).rejects.toMatchObject({ code: "quiesced" });

    const restarted = new RlmRuntimeV2({
      authority: value.authority,
      values: value.values,
      callers: { resolveCaller: () => Promise.resolve(input.caller) },
      operations: { invoke: () => Promise.resolve({ resumed: true }) },
      pollIntervalMs: 1,
    });
    const boot = await restarted.reconcileOnBoot();
    expect(boot.scheduledRunIds).toEqual([input.runId]);
    expect((await restarted.wait(input.runId, 2_000)).state).toBe("completed");
    expect(value.authority.requireRun(input.runId).lifecycleCheckpoint)
      .toBeFalse();
  });

  test("fails closed when encrypted source or result identity is incoherent", async () => {
    const sourceValues = new MemoryValuePort();
    sourceValues.corruptOpenRoles.add("programSource");
    const source = fixture({ values: sourceValues });
    const sourceInput = admission("corrupt01", literalProgram(), caller([]));
    await source.admit(sourceInput);
    expect((await source.runtime.wait(sourceInput.runId, 2_000)).state)
      .toBe("recoveryRequired");

    const resultValues = new MemoryValuePort();
    const result = fixture({ values: resultValues });
    const resultInput = admission("corrupt02", literalProgram(), caller([]));
    await result.admit(resultInput);
    await result.runtime.wait(resultInput.runId, 2_000);
    resultValues.corruptOpenRoles.add("programResult");
    expect(result.runtime.result(resultInput.runId)).rejects
      .toMatchObject({ code: "corrupt_state" });
  });

  test("rejects different stable actors or turns for one run and non-global fuel limits", async () => {
    const value = fixture();
    const input = admission("immutable1", literalProgram(), caller([]));
    await value.admit(input);
    const admittedCaller = parseRlmV2Caller(input.caller);
    const otherActorId = "hactor_runtime_otheractor";
    expect(value.runtime.admit({
      ...input,
      actorId: otherActorId,
      caller: { ...admittedCaller, actorId: otherActorId },
    })).rejects.toMatchObject({ code: "conflict" });
    const otherTurnId = "hturn_runtime_otherturn";
    expect(value.runtime.admit({
      ...input,
      turnId: otherTurnId,
      caller: { ...admittedCaller, turnId: otherTurnId },
    })).rejects.toMatchObject({ code: "conflict" });
    expect(value.runtime.admit({
      ...admission("mismatch1", literalProgram(), caller([])),
      caller: { ...admittedCaller, actorId: otherActorId },
    })).rejects.toMatchObject({ code: "invalid_admission" });
    expect(value.runtime.admit({
      ...admission("immutable2", literalProgram(), caller([])),
      fuelLimit: RLM_V2_MAX_FUEL - 1,
    })).rejects.toMatchObject({ code: "invalid_admission" });
  });

  test("canonical admission identity ignores set ordering but changes with every durable coordinate", () => {
    const capabilities = ["context.read", "agent.spawn", "heap.write"] as const;
    const features = ["boundedPrograms", "recursiveAgents"] as const;
    assertProperty(
      fc.property(
        fc.integer({ min: 0, max: capabilities.length - 1 }),
        fc.integer({ min: 0, max: features.length - 1 }),
        (capabilityRotation, featureRotation) => {
          const original = parseRlmV2Caller({
            ...caller(capabilities),
            admittedFeatures: features,
          });
          const rotatedCaller = parseRlmV2Caller({
            ...original,
            capabilities: rotate(capabilities, capabilityRotation),
            admittedFeatures: rotate(features, featureRotation),
          });
          const base = {
            runId: "rlmrun_property_0001",
            epochId: "hepoch_property_0001",
            actorId: "hactor_property_0001",
            turnId: "hturn_property_0001",
            completedPrefixSnapshotId: "ctxsnap_property_0001",
            currentUserInputValueId: null,
            releaseIdentityDigest: digestB,
            fuelLimit: RLM_V2_MAX_FUEL,
            programDigest: digestA,
          } as const;
          const first = deriveRlmRuntimeAdmissionDigest({ ...base, caller: original });
          const second = deriveRlmRuntimeAdmissionDigest({
            ...base,
            caller: rotatedCaller,
          });
          expect(second).toBe(first);
          expect(deriveRlmRuntimeAdmissionDigest({
            ...base,
            runId: "rlmrun_property_0002",
            caller: original,
          })).not.toBe(first);
          const otherActorId = "hactor_property_other001";
          expect(deriveRlmRuntimeAdmissionDigest({
            ...base,
            actorId: otherActorId,
            caller: { ...original, actorId: otherActorId },
          })).not.toBe(first);
          const otherTurnId = "hturn_property_other0001";
          expect(deriveRlmRuntimeAdmissionDigest({
            ...base,
            turnId: otherTurnId,
            caller: { ...original, turnId: otherTurnId },
          })).not.toBe(first);
        },
      ),
      { ...propertyParameters, numRuns: 200 },
    );
  }, PROPERTY_TIMEOUT);
});

function rotate<T>(values: readonly T[], count: number): readonly T[] {
  return [...values.slice(count), ...values.slice(0, count)];
}
