import { describe, expect, test } from "bun:test";

import type {
  HarnessContextOperationValuePortV2,
  HarnessContextOperationValueRecordV2,
} from "../src/harness/context-value-ports-v2";
import {
  HarnessRootChatAdmissionV2,
  HarnessRootChatAdmissionV2Error,
  defaultHarnessRootBudgetV1,
  type HarnessRootChatLifecyclePortV2,
} from "../src/harness/root-chat-admission-v2";
import {
  deriveHarnessProjectIdV2,
  type HarnessRootProjectResolverPortV2,
} from "../src/harness/root-project-resolver-v2";
import {
  deriveRootActorId,
  deriveRootActorTurnId,
  deriveRootEpochId,
} from "../src/harness/root-actor-authority-v2";

const MIB = 1024 * 1024;
const at = "2030-01-01T00:00:00.000Z";
const sourceSha = "a".repeat(40);
const repositoryId = `repo_${"1".repeat(26)}`;
const workingDirectory = "/tmp/oprte-root-chat-admission-v2";
const gitCommonDirectory = `${workingDirectory}/.git`;
const projectId = deriveHarnessProjectIdV2(workingDirectory);
const paneId = "pane_root_chat_admission_v2_01";
const chatTurnId = "chatturn_root_chat_admission_v2_0001";

function input(prompt = "Inspect the exact repository tree.") {
  return {
    repositoryId,
    canonicalWorkingDirectory: workingDirectory,
    paneId,
    chatTurnId,
    title: "Root chat",
    prompt,
    createdAt: at,
  };
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}

class ExactProjectResolver implements HarnessRootProjectResolverPortV2 {
  readonly calls: unknown[] = [];
  readonly #effectOrder: string[];
  result: unknown = {
    repositoryId,
    projectId,
    canonicalWorkingDirectory: workingDirectory,
    canonicalGitCommonDir: gitCommonDirectory,
    sourceSha,
  };

  constructor(effectOrder: string[]) {
    this.#effectOrder = effectOrder;
  }

  resolveExactProject(value: Readonly<{
    repositoryId: string;
    canonicalWorkingDirectory: string;
    createdAt: string;
  }>): Promise<unknown> {
    this.#effectOrder.push("project");
    this.calls.push(value);
    return Promise.resolve(this.result);
  }
}

class ExactValuePort implements HarnessContextOperationValuePortV2 {
  readonly calls: string[];
  readonly records = new Map<string, Readonly<{
    command: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0];
    value: HarnessContextOperationValueRecordV2;
  }>>();

  constructor(calls: string[]) {
    this.calls = calls;
  }

  putExact(
    command: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0],
  ): Promise<Readonly<{ value: HarnessContextOperationValueRecordV2 }>> {
    this.calls.push("put");
    const existing = this.records.get(command.valueId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.command) !== JSON.stringify(command)) {
        throw new Error("immutable current input conflict");
      }
      return Promise.resolve({ value: existing.value });
    }
    const value = Object.freeze({
      epochId: command.epochId,
      ownerActorId: command.ownerActorId,
      sourceTurnId: command.sourceTurnId,
      valueId: command.valueId,
      kind: command.kind,
      purpose: command.purpose,
      nameDigest: null,
      utf8Bytes: Buffer.byteLength(command.plaintext, "utf8"),
      quotaLimitBytes: command.quotaLimitBytes,
    });
    this.records.set(command.valueId, Object.freeze({ command, value }));
    return Promise.resolve({ value });
  }

  openExact(
    address: Parameters<HarnessContextOperationValuePortV2["openExact"]>[0],
  ): Promise<Readonly<{
    plaintext: string;
    value: HarnessContextOperationValueRecordV2;
  }>> {
    this.calls.push("open");
    const record = this.records.get(address.valueId);
    if (record === undefined) throw new Error("missing current input");
    const commandAddress = {
      epochId: record.command.epochId,
      ownerActorId: record.command.ownerActorId,
      sourceTurnId: record.command.sourceTurnId,
      valueId: record.command.valueId,
      kind: record.command.kind,
      purpose: record.command.purpose,
    };
    if (JSON.stringify(commandAddress) !== JSON.stringify(address)) {
      throw new Error("current input address conflict");
    }
    return Promise.resolve({
      plaintext: record.command.plaintext,
      value: record.value,
    });
  }

  withExactRangeReader<Result>(): Promise<Result> {
    return Promise.reject(new Error("completed-prefix ranges are outside this fixture"));
  }

  withExactActorResultRangeReader<Result>(): Promise<Result> {
    return Promise.reject(new Error("actor-result ranges are outside this fixture"));
  }

  listActive(): Promise<readonly HarnessContextOperationValueRecordV2[]> {
    return Promise.resolve([]);
  }
}

class RootLifecycle implements HarnessRootChatLifecyclePortV2 {
  readonly calls: string[];
  readonly preparedInputs: unknown[] = [];
  readonly admittedInputs: unknown[] = [];
  readonly settlementInputs: unknown[] = [];
  lastTurn: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    inputValueId: string;
  }> | null = null;

  constructor(calls: string[]) {
    this.calls = calls;
  }

  prepareRoot(value: Parameters<HarnessRootChatLifecyclePortV2["prepareRoot"]>[0]) {
    this.calls.push("prepare");
    this.preparedInputs.push(value);
    const epochId = deriveRootEpochId({
      projectId: value.projectId,
      sourceSha: value.sourceSha,
      paneId: value.paneId,
    });
    return Promise.resolve({
      epoch: { id: epochId },
      actor: { id: deriveRootActorId(epochId) },
      plannedTurnId: deriveRootActorTurnId(epochId, value.chatTurnId),
    });
  }

  admitRootTurn(value: Parameters<HarnessRootChatLifecyclePortV2["admitRootTurn"]>[0]) {
    this.calls.push("admit");
    this.admittedInputs.push(value);
    const epochId = deriveRootEpochId({
      projectId: value.projectId,
      sourceSha: value.sourceSha,
      paneId: value.paneId,
    });
    const actorId = deriveRootActorId(epochId);
    const turnId = deriveRootActorTurnId(epochId, value.chatTurnId);
    this.lastTurn = { epochId, actorId, turnId, inputValueId: value.inputValueId };
    return Promise.resolve({
      epoch: { id: epochId },
      actor: { id: actorId },
      turn: { id: turnId, inputValueId: value.inputValueId, state: "running" },
    });
  }

  settleBeforeProvider(
    value: Parameters<
      HarnessRootChatLifecyclePortV2["settleBeforeProvider"]
    >[0],
  ) {
    this.calls.push("settle");
    this.settlementInputs.push(value);
    if (this.lastTurn === null) throw new Error("root is not admitted");
    const ambiguous = value.failure === "provider_start_ambiguous";
    return Promise.resolve({
      id: value.turnId,
      epochId: this.lastTurn.epochId,
      actorId: this.lastTurn.actorId,
      ordinal: 1,
      idempotencyKey: "root-chat-admission-idempotency",
      inputValueId: this.lastTurn.inputValueId,
      state: ambiguous ? "ambiguous" : "failed",
      desiredState: "run",
      revision: 4,
      createdAt: at,
      startedAt: at,
      settledAt: value.settledAt ?? at,
      outcomeCode: ambiguous
        ? "codex_provider_start_ambiguous"
        : "codex_provider_unavailable_before_start",
    });
  }
}

function fixture() {
  const calls: string[] = [];
  const projects = new ExactProjectResolver(calls);
  const roots = new RootLifecycle(calls);
  const values = new ExactValuePort(calls);
  return {
    calls,
    projects,
    roots,
    values,
    service: new HarnessRootChatAdmissionV2({ projects, roots, values }),
  };
}

describe("HarnessRootChatAdmissionV2", () => {
  test("publishes one exact current input before exposing provider readiness", async () => {
    const value = fixture();
    const first = await value.service.admit(input());
    expect(value.calls).toEqual([
      "project",
      "prepare",
      "put",
      "open",
      "admit",
    ]);
    expect(first).toMatchObject({
      projectId,
      sourceSha,
      paneId,
      chatTurnId,
      readyForProvider: true,
    });
    expect(value.projects.calls).toEqual([{
      repositoryId,
      canonicalWorkingDirectory: workingDirectory,
      createdAt: at,
    }]);
    expect(value.roots.preparedInputs[0]).toMatchObject({
      projectId,
      sourceSha,
      paneId,
      chatTurnId,
      budget: defaultHarnessRootBudgetV1(at),
    });
    expect(value.values.records.get(first.currentInputValueId)?.command)
      .toEqual({
        operationId: first.currentInputOperationId,
        epochId: first.epochId,
        ownerActorId: first.actorId,
        sourceTurnId: null,
        valueId: first.currentInputValueId,
        kind: "text",
        purpose: "currentInput",
        plaintext: input().prompt,
        quotaLimitBytes: 16 * MIB,
        name: null,
      });
    expect(JSON.stringify(first)).not.toMatch(
      /accountProfile|processGeneration|providerThread|providerTurn/i,
    );

    value.calls.splice(0);
    const replay = await value.service.admit(input());
    expect(replay).toEqual(first);
    expect(value.calls).toEqual([
      "project",
      "prepare",
      "put",
      "open",
      "admit",
    ]);
    expect(value.values.records).toHaveLength(1);
  });

  test("uses the fixed v1 root budget and honors a validated override", async () => {
    expect(defaultHarnessRootBudgetV1(at)).toEqual({
      depthRemaining: 3,
      activeDescendantLimit: 8,
      durableDescendantLimit: 50,
      tokenBudget: 100_000,
      deadline: "2038-01-01T00:00:00.000Z",
      heapByteLimit: 16 * MIB,
      contextValueByteLimit: MIB,
      messageByteLimit: 128 * 1024,
      laneAuthority: "managedWrite",
    });
    expect(() => defaultHarnessRootBudgetV1(
      "2038-01-01T00:00:00.000Z",
    )).toThrow("bounded epoch deadline");
    const value = fixture();
    const budget = {
      ...defaultHarnessRootBudgetV1(at, 8 * MIB),
      tokenBudget: 50_000,
    };
    await value.service.admit({
      ...input(),
      contextQuotaBytes: 8 * MIB,
      budget,
    });
    expect(value.roots.preparedInputs[0]).toMatchObject({ budget });
    expect([...value.values.records.values()][0]?.value.quotaLimitBytes)
      .toBe(8 * MIB);
  });

  test("rejects quota-divergent custom budgets before every effect", async () => {
    const baseline = defaultHarnessRootBudgetV1(at);
    const divergentBudgets = [
      {
        ...baseline,
        heapByteLimit: 8 * MIB,
      },
      {
        ...baseline,
        heapByteLimit: 32 * MIB,
      },
    ];
    for (const budget of divergentBudgets) {
      const value = fixture();
      expect(await captureRejection(value.service.admit({
          ...input(),
          budget,
        })))
        .toMatchObject({ code: "invalid_budget" });
      expect(value.calls).toEqual([]);
      expect(value.projects.calls).toEqual([]);
      expect(value.roots.preparedInputs).toEqual([]);
      expect(value.roots.admittedInputs).toEqual([]);
      expect(value.values.records).toHaveLength(0);
    }
  });

  test("keeps one epoch budget stable across a later turn and restart", async () => {
    const value = fixture();
    const first = await value.service.admit(input());
    const restarted = new HarnessRootChatAdmissionV2({
      projects: value.projects,
      roots: value.roots,
      values: value.values,
    });
    const second = await restarted.admit({
      ...input("Continue from the completed prefix."),
      chatTurnId: "chatturn_root_chat_admission_v2_0002",
      createdAt: "2030-01-03T00:00:00.000Z",
    });
    expect(second.epochId).toBe(first.epochId);
    expect(second.actorId).toBe(first.actorId);
    expect(second.turnId).not.toBe(first.turnId);
    expect(value.roots.preparedInputs).toHaveLength(2);
    expect(value.roots.preparedInputs[1]).toMatchObject({
      budget: defaultHarnessRootBudgetV1("2030-01-03T00:00:00.000Z"),
    });
    expect(value.roots.preparedInputs[1]).toMatchObject({
      budget: value.roots.preparedInputs[0] === undefined
        ? undefined
        : (value.roots.preparedInputs[0] as { budget: unknown }).budget,
    });
    expect(value.values.records).toHaveLength(2);
  });

  test("fails closed on source echo, prompt replay, and input violations", async () => {
    const wrongSource = fixture();
    wrongSource.projects.result = {
      repositoryId,
      projectId: `proj_${"f".repeat(24)}`,
      canonicalWorkingDirectory: workingDirectory,
      canonicalGitCommonDir: gitCommonDirectory,
      sourceSha,
    };
    expect(wrongSource.service.admit(input())).rejects.toMatchObject({
      code: "identity_conflict",
    });
    expect(wrongSource.calls).toEqual(["project"]);

    const changed = fixture();
    await changed.service.admit(input());
    expect(changed.service.admit(input("A substituted prompt.")))
      .rejects.toBeInstanceOf(HarnessRootChatAdmissionV2Error);
    expect(changed.roots.admittedInputs).toHaveLength(1);
    expect(changed.values.records).toHaveLength(1);

    const invalid = fixture();
    expect(invalid.service.admit({
      ...input(),
      canonicalWorkingDirectory: `${workingDirectory}\0escape`,
    })).rejects.toBeDefined();
    expect(invalid.service.admit({
      ...input(),
      prompt: "x".repeat(MIB + 1),
    })).rejects.toMatchObject({ code: "invalid_budget" });
    expect(invalid.projects.calls).toEqual([]);
  });

  test("settles admitted roots explicitly before provider start", async () => {
    const unavailable = fixture();
    const admitted = await unavailable.service.admit(input());
    expect(await unavailable.service.settleBeforeProvider({
      turnId: admitted.turnId,
      paneId,
      failure: "provider_unavailable",
      settledAt: at,
    })).toEqual({
      turnId: admitted.turnId,
      state: "failed",
      outcomeCode: "codex_provider_unavailable_before_start",
    });

    const ambiguous = fixture();
    const second = await ambiguous.service.admit(input());
    expect(await ambiguous.service.settleBeforeProvider({
      turnId: second.turnId,
      paneId,
      failure: "provider_start_ambiguous",
      settledAt: at,
    })).toEqual({
      turnId: second.turnId,
      state: "ambiguous",
      outcomeCode: "codex_provider_start_ambiguous",
    });
    expect(JSON.stringify(ambiguous.roots.settlementInputs))
      .not.toMatch(/account|thread/i);
  });
});
