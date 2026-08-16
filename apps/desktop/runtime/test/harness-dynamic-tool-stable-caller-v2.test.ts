import { describe, expect, test } from "bun:test";

import {
  HarnessDynamicToolStableCallerAuthorityV2,
  deriveHarnessDynamicToolRunId,
  deriveHarnessDynamicToolStableCallIdentityDigest,
  type HarnessDynamicToolActorResolverPortV2,
  type HarnessDynamicToolContextMaterializationInputV2,
  type HarnessDynamicToolContextMaterializerPortV2,
  type HarnessDynamicToolEvidenceSettingsPortV2,
  type HarnessDynamicToolRunLookupPortV2,
  type HarnessDynamicToolSessionPortV2,
} from "../src/harness/dynamic-tool-stable-caller-v2";
import type { HarnessDynamicToolStableCall } from "../src/harness/dynamic-tool-service-v2";
import {
  rlmRunRecordSchema,
  type RlmRunRecord,
} from "../src/harness/rlm-run-authority-v2";
import {
  deriveRootActorId,
  deriveRootActorTurnId,
  deriveRootEpochId,
} from "../src/harness/root-actor-authority-v2";
import {
  RLM_V2_MAX_FUEL,
  digestRlmV2Program,
  parseRlmV2Program,
} from "../src/harness/rlm-v2";

const createdAt = "2030-01-01T00:00:00.000Z";
const laterTurnAt = "2030-01-01T00:00:02.000Z";
const now = Date.parse("2030-01-01T00:00:01.000Z");
const deadline = "2030-01-02T00:00:00.000Z";
const durableProjectId = "repository-stable-dynamic-caller";
const sessionProjectId = "proj_session_stable_dynamic";
const sourceSha = "1".repeat(40);
const paneId = "pane_stable_dynamic_root_01";
const chatTurnId = "chatturn_stable_dynamic_root_01";
const gatewayThreadId = "thread_gateway_stable_dynamic_01";
const gatewayTurnId = "turn_gateway_stable_dynamic_001";
const laterGatewayTurnId = "turn_gateway_stable_dynamic_002";
const gatewayLaneId = "lane_gateway_stable_dynamic_01";
const providerAccount = "acct_private_stable_dynamic";
const providerThread = "provider-private-thread-01";
const providerTurn = "provider-private-turn-01";
const providerCall = "provider-private-call-01";
const workspacePath = "/private/provider/worktree";
const callDigest = "a".repeat(64);
const coverageWitnessDigest = "b".repeat(64);
const semanticWitnessDigest = "c".repeat(64);
const releaseIdentityDigest = "d".repeat(64);
const inputValueId = "ctxval_stable_dynamic_input01";
const laterInputValueId = "ctxval_stable_dynamic_input02";
const snapshotId = "ctxsnap_stable_dynamic_prefix01";
const epochId = deriveRootEpochId({
  projectId: durableProjectId,
  sourceSha,
  paneId,
});
const actorId = deriveRootActorId(epochId);
const turnId = deriveRootActorTurnId(epochId, chatTurnId);
const laterTurnId = "hturn_stable_dynamic_root002";

const actorBudget = Object.freeze({
  maxDepth: 3,
  maxActiveDescendants: 8,
  maxDurableDescendants: 50,
  tokenBudget: 100_000,
  byteBudget: 16 * 1024 * 1024,
  deadline,
  laneAuthority: "managedWrite" as const,
});
const recursiveBudget = Object.freeze({
  depthRemaining: 3,
  activeDescendantLimit: 8,
  durableDescendantLimit: 50,
  tokenBudget: 100_000,
  deadline,
  heapByteLimit: 16 * 1024 * 1024,
  contextValueByteLimit: 1024 * 1024,
  messageByteLimit: 128 * 1024,
  laneAuthority: "managedWrite" as const,
});
const rootCaller = Object.freeze({
  epoch: Object.freeze({
    id: epochId,
    projectId: durableProjectId,
    sourceSha,
    rootActorId: actorId,
    budget: actorBudget,
    tokenReserved: 0,
    byteReserved: 0,
    nextRootCompletionSequence: 1,
    state: "active" as const,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    stoppedAt: null,
  }),
  actor: Object.freeze({
    id: actorId,
    epochId,
    parentActorId: null,
    depth: 0,
    title: "Stable dynamic root",
    state: "active" as const,
    budget: actorBudget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 2,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    stoppedAt: null,
  }),
  turn: Object.freeze({
    id: turnId,
    epochId,
    actorId,
    ordinal: 1,
    idempotencyKey: "stable-dynamic-root-turn-0001",
    inputValueId,
    state: "running" as const,
    desiredState: "run" as const,
    revision: 2,
    createdAt,
    startedAt: createdAt,
    settledAt: null,
    outcomeCode: null,
  }),
  completedThroughTurnId: null,
});

const sessionCaller = Object.freeze({
  generation: 7,
  projectId: sessionProjectId,
  threadId: gatewayThreadId,
  turnId: gatewayTurnId,
  workspaceLaneId: gatewayLaneId,
  workspaceMode: "local" as const,
  workspacePath,
});
const contextAdmission = Object.freeze({
  completedHistory: Object.freeze({
    coverage: "complete" as const,
    throughTurnId: gatewayTurnId,
    sourceGeneration: 7,
    sourceStreamPosition: 41,
    coverageWitnessDigest,
    items: Object.freeze([
      Object.freeze({
        ordinal: 0,
        turnId: "turn_gateway_completed_001",
        itemClass: "userMessage" as const,
        text: "Earlier question",
      }),
      Object.freeze({
        ordinal: 1,
        turnId: "turn_gateway_completed_001",
        itemClass: "assistantMessage" as const,
        text: "Earlier answer",
      }),
    ]),
  }),
  currentInput: Object.freeze({
    turnId: gatewayTurnId,
    sourceGeneration: 7,
    sourceStreamPosition: 41,
    coverageWitnessDigest,
    text: "Current private input",
  }),
});
const settings = Object.freeze({
  capabilities: Object.freeze([
    "agent.cancel",
    "agent.message",
    "agent.spawn",
    "agent.wait",
    "heap.read",
    "heap.write",
  ] as const),
  admittedFeatures: Object.freeze([
    "boundedPrograms",
    "recursiveAgents",
  ] as const),
  semanticWitnessDigests: Object.freeze([semanticWitnessDigest]),
  budget: recursiveBudget,
  releaseIdentityDigest,
});
const contextualSettings = Object.freeze({
  ...settings,
  capabilities: Object.freeze([
    "agent.cancel",
    "agent.message",
    "agent.spawn",
    "agent.wait",
    "context.materialize",
    "context.read",
    "heap.read",
    "heap.write",
  ] as const),
  admittedFeatures: Object.freeze([
    "boundedPrograms",
    "contextMaterialization",
    "contextReferences",
    "recursiveAgents",
  ] as const),
  semanticWitnessDigests: Object.freeze([
    coverageWitnessDigest,
    semanticWitnessDigest,
  ]),
});
const program = parseRlmV2Program({
  version: 2,
  capabilities: [],
  steps: [],
  result: { kind: "literal", value: { accepted: true } },
});
const programDigest = digestRlmV2Program(program);

function stableCall(
  overrides: Partial<HarnessDynamicToolStableCall> = {},
): HarnessDynamicToolStableCall {
  return {
    accountProfileId: providerAccount,
    accountGeneration: 7,
    processGeneration: 7,
    providerThreadId: providerThread,
    providerTurnId: providerTurn,
    providerCallId: providerCall,
    requestInstanceId: 19,
    callDigest,
    ...overrides,
  };
}

class Ports implements
  HarnessDynamicToolSessionPortV2,
  HarnessDynamicToolActorResolverPortV2,
  HarnessDynamicToolContextMaterializerPortV2,
  HarnessDynamicToolEvidenceSettingsPortV2,
  HarnessDynamicToolRunLookupPortV2 {
  sessionValue: unknown = sessionCaller;
  rootValue: unknown = rootCaller;
  nestedValue: unknown = null;
  contextValue: unknown = contextAdmission;
  settingsValue: unknown = settings;
  materializedValue: unknown = {
    completedPrefixSnapshotId: snapshotId,
    currentUserInputValueId: inputValueId,
    coverageWitnessDigest,
  };
  snapshotValue: unknown = {
    id: snapshotId,
    epochId,
    actorId,
    completedThroughTurnId: null,
    coverageWitnessDigest,
    valueId: "ctxval_stable_dynamic_prefix01",
    createdAt,
    expiresAt: deadline,
  };
  readonly runs = new Map<string, RlmRunRecord>();
  readonly sessionLookups: unknown[][] = [];
  readonly rootLookups: unknown[] = [];
  readonly nestedLookups: unknown[] = [];
  readonly contextReads: unknown[][] = [];
  readonly settingsReads: unknown[] = [];
  readonly materializations: HarnessDynamicToolContextMaterializationInputV2[] = [];
  onMaterialize: (() => void) | null = null;

  resolveHarnessCaller(...input: unknown[]): unknown {
    this.sessionLookups.push(input);
    return this.sessionValue;
  }

  readHarnessContextAdmission(...input: unknown[]): unknown {
    this.contextReads.push(input);
    return this.contextValue;
  }

  resolveRootCaller(input: unknown): unknown {
    this.rootLookups.push(input);
    return this.rootValue;
  }

  resolveNestedCaller(input: unknown): unknown {
    this.nestedLookups.push(input);
    return this.nestedValue;
  }

  readAcceptedSettings(input: unknown): unknown {
    this.settingsReads.push(input);
    return this.settingsValue;
  }

  materialize(input: HarnessDynamicToolContextMaterializationInputV2): unknown {
    this.materializations.push(input);
    this.onMaterialize?.();
    return this.materializedValue;
  }

  readRun(runIdValue: string): RlmRunRecord | null {
    return this.runs.get(runIdValue) ?? null;
  }

  readContextSnapshot(snapshotIdValue: string): unknown {
    return typeof this.snapshotValue === "object" &&
        this.snapshotValue !== null &&
        "id" in this.snapshotValue &&
        this.snapshotValue.id === snapshotIdValue
      ? this.snapshotValue
      : null;
  }
}

function authority(ports: Ports) {
  return new HarnessDynamicToolStableCallerAuthorityV2({
    sessions: ports,
    actors: ports,
    contexts: ports,
    evidence: ports,
    runs: ports,
    now: () => now,
  });
}

function expectedRunId(
  call: HarnessDynamicToolStableCall = stableCall(),
): string {
  return deriveHarnessDynamicToolRunId({
    epochId,
    actorId,
    turnId,
    programDigest,
    providerCallId: call.providerCallId,
    stableAdmissionIdentityDigest:
      deriveHarnessDynamicToolStableCallIdentityDigest(call),
  });
}

function setLaterRootCaller(ports: Ports): void {
  ports.sessionValue = {
    ...sessionCaller,
    turnId: laterGatewayTurnId,
  };
  ports.rootValue = {
    ...rootCaller,
    actor: {
      ...rootCaller.actor,
      nextTurnOrdinal: 3,
    },
    turn: {
      ...rootCaller.turn,
      id: laterTurnId,
      ordinal: 2,
      idempotencyKey: "stable-dynamic-root-turn-0002",
      inputValueId: laterInputValueId,
      createdAt: laterTurnAt,
      startedAt: laterTurnAt,
    },
    completedThroughTurnId: turnId,
  };
}

function runRecord(
  overrides: Partial<RlmRunRecord> = {},
): RlmRunRecord {
  return rlmRunRecordSchema.parse({
    id: expectedRunId(),
    epochId,
    actorId,
    turnId,
    programValueId: "ctxval_stable_dynamic_program1",
    programDigest,
    completedPrefixSnapshotId: snapshotId,
    currentUserInputValueId: inputValueId,
    capabilities: contextualSettings.capabilities,
    admittedFeatures: contextualSettings.admittedFeatures,
    semanticWitnessDigests: contextualSettings.semanticWitnessDigests,
    budget: settings.budget,
    fuelLimit: RLM_V2_MAX_FUEL,
    deadline,
    releaseIdentityDigest,
    admissionDigest: "e".repeat(64),
    desiredState: "run",
    lifecycleCheckpoint: false,
    state: "prepared",
    terminalResultValueId: null,
    terminalCode: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    settledAt: null,
    ...overrides,
  });
}

describe("HarnessDynamicToolStableCallerAuthorityV2", () => {
  test("admits a root caller without leaking transient provider identity", async () => {
    const ports = new Ports();
    expect(rootCaller.epoch.projectId).not.toBe(sessionCaller.projectId);
    const admitted = await authority(ports).admit({
      call: stableCall(),
      program,
      programDigest,
    });

    expect(admitted).toEqual({
      runId: expectedRunId(),
      epochId,
      actorId,
      turnId,
      completedPrefixSnapshotId: snapshotId,
      currentUserInputValueId: inputValueId,
      releaseIdentityDigest,
      caller: {
        epochId,
        actorId,
        turnId,
        capabilities: contextualSettings.capabilities,
        admittedFeatures: contextualSettings.admittedFeatures,
        semanticWitnessDigests: contextualSettings.semanticWitnessDigests,
        budget: settings.budget,
      },
    });
    expect(ports.materializations).toHaveLength(1);
    expect(ports.materializations[0]).toEqual({
      runId: expectedRunId(),
      epochId,
      actorId,
      turnId,
      currentInputValueId: inputValueId,
      currentInputProvenance: {
        valueId: inputValueId,
        purpose: "currentInput",
        sourceTurnId: null,
      },
      completedThroughTurnId: null,
      expiresAt: deadline,
      programDigest,
      stableAdmissionIdentityDigest:
        deriveHarnessDynamicToolStableCallIdentityDigest(stableCall()),
      coverageWitnessDigest,
      completedPrefix: [
        { ordinal: 0, itemClass: "userMessage", text: "Earlier question" },
        { ordinal: 1, itemClass: "assistantMessage", text: "Earlier answer" },
      ],
      currentInput: "Current private input",
    });
    const durableJson = JSON.stringify({ admitted, input: ports.materializations[0] });
    for (const transient of [
      providerAccount,
      providerThread,
      providerTurn,
      providerCall,
      workspacePath,
      gatewayThreadId,
      gatewayTurnId,
    ]) expect(durableJson).not.toContain(transient);
    expect(ports.rootLookups).toHaveLength(2);
    expect(ports.nestedLookups).toHaveLength(2);
  });

  test("ignores transport lookup identity but binds authenticated provider call identity", async () => {
    const firstPorts = new Ports();
    const secondPorts = new Ports();
    secondPorts.sessionValue = { ...sessionCaller, generation: 83 };
    secondPorts.contextValue = {
      completedHistory: {
        ...contextAdmission.completedHistory,
        sourceGeneration: 83,
      },
      currentInput: {
        ...contextAdmission.currentInput,
        sourceGeneration: 83,
      },
    };
    const first = await authority(firstPorts).admit({
      call: stableCall(),
      program,
      programDigest,
    });
    const second = await authority(secondPorts).admit({
      call: stableCall({
        accountProfileId: "acct_other_private_lookup",
        accountGeneration: 83,
        processGeneration: 83,
        providerThreadId: "another-provider-thread",
        providerTurnId: "another-provider-turn",
        providerCallId: providerCall,
        requestInstanceId: 991,
      }),
      program,
      programDigest,
    });
    expect(second).toEqual(first);
    const differentCall = stableCall({
      providerCallId: "another-provider-call",
    });
    const thirdPorts = new Ports();
    const third = await authority(thirdPorts).admit({
      call: differentCall,
      program,
      programDigest,
    });
    expect(third?.runId).toBe(expectedRunId(differentCall));
    expect(third?.runId).not.toBe(first?.runId);
    expect(deriveHarnessDynamicToolRunId({
      epochId,
      actorId,
      turnId,
      programDigest,
      providerCallId: providerCall,
      stableAdmissionIdentityDigest: "f".repeat(64),
    })).not.toBe(expectedRunId());
  });

  test("replays the exact stored admission without rematerializing context", async () => {
    const ports = new Ports();
    const stored = runRecord({
      completedPrefixSnapshotId: "ctxsnap_stored_dynamic_prefix01",
      currentUserInputValueId: null,
    });
    ports.snapshotValue = {
      ...(ports.snapshotValue as Record<string, unknown>),
      id: stored.completedPrefixSnapshotId,
    };
    ports.runs.set(stored.id, stored);
    const admitted = await authority(ports).admit({
      call: stableCall(),
      program,
      programDigest,
    });
    expect(admitted).toMatchObject({
      runId: stored.id,
      completedPrefixSnapshotId: stored.completedPrefixSnapshotId,
      currentUserInputValueId: null,
    });
    expect(ports.contextReads).toHaveLength(0);
    expect(ports.materializations).toHaveLength(0);
  });

  test("admits an exact nested attempt with its remaining depth budget", async () => {
    const ports = new Ports();
    ports.sessionValue = { ...sessionCaller, workspaceMode: "managed" };
    expect(rootCaller.epoch.projectId).not.toBe(sessionCaller.projectId);
    const nestedActorId = "hactor_stable_dynamic_child01";
    const nestedTurnId = "hturn_stable_dynamic_child001";
    const nestedInputValueId = "ctxval_stable_dynamic_child01";
    const nestedCompletedTurnId = "hturn_stable_dynamic_child000";
    ports.rootValue = null;
    ports.nestedValue = {
      epoch: rootCaller.epoch,
      actor: {
        ...rootCaller.actor,
        id: nestedActorId,
        parentActorId: actorId,
        depth: 1,
        title: "Stable nested caller",
      },
      turn: {
        ...rootCaller.turn,
        id: nestedTurnId,
        actorId: nestedActorId,
        ordinal: 2,
        inputValueId: nestedInputValueId,
      },
      completedThroughTurnId: nestedCompletedTurnId,
    };
    ports.settingsValue = {
      ...settings,
      budget: { ...recursiveBudget, depthRemaining: 2 },
    };
    ports.materializedValue = {
      completedPrefixSnapshotId: snapshotId,
      currentUserInputValueId: nestedInputValueId,
      coverageWitnessDigest,
    };
    const admitted = await authority(ports).admit({
      call: stableCall(),
      program,
      programDigest,
    });
    expect(admitted).toMatchObject({
      actorId: nestedActorId,
      turnId: nestedTurnId,
      caller: { budget: { depthRemaining: 2 } },
    });
    expect(ports.materializations[0]?.currentInputProvenance).toEqual({
      valueId: nestedInputValueId,
      purpose: "actorTask",
      sourceTurnId: nestedTurnId,
    });
    expect(ports.materializations[0]?.completedThroughTurnId)
      .toBe(nestedCompletedTurnId);
    expect(ports.materializations[0]?.expiresAt).toBe(deadline);

    const localNested = new Ports();
    localNested.rootValue = null;
    localNested.nestedValue = ports.nestedValue;
    localNested.settingsValue = ports.settingsValue;
    localNested.materializedValue = ports.materializedValue;
    expect(await authority(localNested).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();
  });

  test("rejects ambiguous actor authority and exact resolver refusal", async () => {
    const ambiguous = new Ports();
    ambiguous.nestedValue = rootCaller;
    expect(await authority(ambiguous).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();
    expect(ambiguous.materializations).toHaveLength(0);

    const refused = new Ports();
    refused.rootValue = null;
    expect(await authority(refused).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();
    expect(refused.materializations).toHaveLength(0);

    const missingAnchor = new Ports();
    missingAnchor.rootValue = {
      ...rootCaller,
      turn: { ...rootCaller.turn, ordinal: 2 },
      completedThroughTurnId: null,
    };
    expect(await authority(missingAnchor).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();
    expect(missingAnchor.materializations).toHaveLength(0);
  });

  test("rejects mixed-prefix context, stale evidence, and a substituted input value", async () => {
    const contextProgram = parseRlmV2Program({
      version: 2,
      capabilities: ["context.read", "context.materialize"],
      steps: [],
      result: { kind: "literal", value: { accepted: true } },
    });
    const exact = new Ports();
    expect(await authority(exact).admit({
      call: stableCall(),
      program: contextProgram,
      programDigest: digestRlmV2Program(contextProgram),
    })).not.toBeNull();

    const partial = new Ports();
    partial.contextValue = {
      ...contextAdmission,
      completedHistory: {
        ...contextAdmission.completedHistory,
        coverage: "partial",
        items: [],
      },
    };
    expect(await authority(partial).admit({
      call: stableCall(),
      program: contextProgram,
      programDigest: digestRlmV2Program(contextProgram),
    })).toBeNull();
    expect(partial.materializations).toHaveLength(0);

    const mixed = new Ports();
    mixed.contextValue = {
      ...contextAdmission,
      completedHistory: {
        ...contextAdmission.completedHistory,
        items: [{
          ordinal: 0,
          turnId: gatewayTurnId,
          itemClass: "userMessage",
          text: "Current input copied into completed history",
        }],
      },
    };
    expect(await authority(mixed).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();
    expect(mixed.materializations).toHaveLength(0);

    const stale = new Ports();
    stale.settingsValue = {
      ...settings,
      budget: { ...recursiveBudget, tokenBudget: recursiveBudget.tokenBudget + 1 },
    };
    expect(await authority(stale).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();

    const substituted = new Ports();
    substituted.materializedValue = {
      completedPrefixSnapshotId: snapshotId,
      currentUserInputValueId: "ctxval_substituted_dynamic_input1",
      coverageWitnessDigest,
    };
    expect(await authority(substituted).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();

    const raced = new Ports();
    raced.onMaterialize = () => {
      raced.rootValue = {
        ...rootCaller,
        turn: {
          ...rootCaller.turn,
          inputValueId: "ctxval_changed_after_materialize01",
        },
      };
    };
    expect(await authority(raced).admit({
      call: stableCall(),
      program,
      programDigest,
    })).toBeNull();
  });

  test("owns a run only while the exact live caller and stored authority agree", async () => {
    const ports = new Ports();
    const run = runRecord();
    ports.runs.set(run.id, run);
    expect(await authority(ports).ownsRun({
      call: stableCall({ callDigest: "9".repeat(64) }),
      runId: run.id,
    })).toBe(true);
    expect(ports.contextReads).toHaveLength(0);
    expect(ports.materializations).toHaveLength(0);

    ports.settingsValue = {
      ...settings,
      admittedFeatures: ["boundedPrograms"],
    };
    expect(await authority(ports).ownsRun({
      call: stableCall(),
      runId: run.id,
    })).toBe(false);

    ports.settingsValue = settings;
    ports.rootValue = null;
    expect(await authority(ports).ownsRun({
      call: stableCall(),
      runId: run.id,
    })).toBe(false);
  });

  test("lets a restarted later turn inspect the same actor's immutable origin run", async () => {
    const ports = new Ports();
    const origin = runRecord();
    ports.runs.set(origin.id, origin);
    setLaterRootCaller(ports);
    ports.sessionValue = {
      ...(ports.sessionValue as typeof sessionCaller),
      generation: 8,
    };
    ports.settingsValue = {
      ...settings,
      semanticWitnessDigests: ["7".repeat(64)],
      releaseIdentityDigest: "6".repeat(64),
    };

    expect(await authority(ports).ownsRun({
      call: stableCall({
        accountProfileId: "acct_restarted_stable_dynamic",
        accountGeneration: 8,
        processGeneration: 8,
        providerThreadId: "provider-restarted-thread-01",
        providerTurnId: "provider-restarted-turn-02",
      }),
      runId: origin.id,
    })).toBe(true);
    expect(origin.turnId).toBe(turnId);
    expect((ports.rootValue as typeof rootCaller).turn.id).toBe(laterTurnId);
    const evidenceBinding = {
      epochId,
      actorId,
      turnId: laterTurnId,
      requestInstanceId: 19,
      accountProfileId: "acct_restarted_stable_dynamic",
      accountGeneration: 8,
      processGeneration: 8,
    };
    expect(ports.settingsReads).toEqual([
      evidenceBinding,
      evidenceBinding,
    ]);
  });

  test("keeps later inspection inside one live epoch and actor", async () => {
    const origin = runRecord();

    const sibling = new Ports();
    setLaterRootCaller(sibling);
    sibling.sessionValue = {
      ...(sibling.sessionValue as typeof sessionCaller),
      workspaceMode: "managed",
    };
    sibling.rootValue = null;
    sibling.nestedValue = {
      ...rootCaller,
      epoch: rootCaller.epoch,
      actor: {
        ...rootCaller.actor,
        id: "hactor_stable_dynamic_sibling1",
        parentActorId: actorId,
        depth: 1,
      },
      turn: {
        ...rootCaller.turn,
        id: "hturn_stable_dynamic_sibling01",
        actorId: "hactor_stable_dynamic_sibling1",
        ordinal: 2,
        inputValueId: "ctxval_stable_dynamic_sibling1",
        createdAt: laterTurnAt,
        startedAt: laterTurnAt,
      },
      completedThroughTurnId: turnId,
    };
    sibling.settingsValue = {
      ...settings,
      budget: { ...recursiveBudget, depthRemaining: 2 },
    };
    sibling.runs.set(origin.id, origin);
    expect(await authority(sibling).ownsRun({
      call: stableCall(),
      runId: origin.id,
    })).toBe(false);

    const newEpoch = new Ports();
    const replacementEpochId = "hepoch_stable_dynamic_replacement1";
    const replacementActorId = "hactor_stable_dynamic_replacement1";
    newEpoch.rootValue = {
      ...rootCaller,
      epoch: {
        ...rootCaller.epoch,
        id: replacementEpochId,
        rootActorId: replacementActorId,
      },
      actor: {
        ...rootCaller.actor,
        id: replacementActorId,
        epochId: replacementEpochId,
      },
      turn: {
        ...rootCaller.turn,
        id: "hturn_stable_dynamic_replacement1",
        epochId: replacementEpochId,
        actorId: replacementActorId,
      },
    };
    newEpoch.runs.set(origin.id, origin);
    expect(await authority(newEpoch).ownsRun({
      call: stableCall(),
      runId: origin.id,
    })).toBe(false);

    const terminalCurrent = new Ports();
    setLaterRootCaller(terminalCurrent);
    terminalCurrent.rootValue = {
      ...(terminalCurrent.rootValue as typeof rootCaller),
      turn: {
        ...(terminalCurrent.rootValue as typeof rootCaller).turn,
        state: "succeeded",
        settledAt: laterTurnAt,
        outcomeCode: "completed",
      },
    };
    terminalCurrent.runs.set(origin.id, origin);
    expect(await authority(terminalCurrent).ownsRun({
      call: stableCall(),
      runId: origin.id,
    })).toBe(false);
  });

  test("preserves terminal inspection but rejects recovery-required runs and removed features", async () => {
    for (const state of ["completed", "failed", "stopped"] as const) {
      const ports = new Ports();
      setLaterRootCaller(ports);
      const terminal = runRecord({
        state,
        desiredState: state === "stopped" ? "stop" : "run",
        terminalResultValueId: state === "completed"
          ? "ctxval_stable_dynamic_result01"
          : null,
        terminalCode: `run_${state}`,
        revision: 3,
        updatedAt: laterTurnAt,
        settledAt: laterTurnAt,
      });
      ports.runs.set(terminal.id, terminal);
      expect(await authority(ports).ownsRun({
        call: stableCall(),
        runId: terminal.id,
      })).toBe(true);
    }

    const recovery = new Ports();
    setLaterRootCaller(recovery);
    const recoveryRun = runRecord({
      state: "recoveryRequired",
      terminalCode: "recovery_required",
      revision: 3,
      updatedAt: laterTurnAt,
      settledAt: laterTurnAt,
    });
    recovery.runs.set(recoveryRun.id, recoveryRun);
    expect(await authority(recovery).ownsRun({
      call: stableCall(),
      runId: recoveryRun.id,
    })).toBe(false);

    const removed = new Ports();
    setLaterRootCaller(removed);
    removed.settingsValue = {
      ...settings,
      capabilities: [],
    };
    const removedRun = runRecord();
    removed.runs.set(removedRun.id, removedRun);
    expect(await authority(removed).ownsRun({
      call: stableCall(),
      runId: removedRun.id,
    })).toBe(false);
  });
});
