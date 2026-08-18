import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  CodexJsonlWriter,
  HRA_RLM_DYNAMIC_TOOL_SPEC,
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  PinnedCodexDynamicToolLedger,
  PinnedCodexProtocol,
  acceptPinnedCodexDynamicToolProbeWitness,
  isPinnedCodexDynamicToolProbeWitness,
  pinnedCodexRequests,
  parsePinnedCodexDynamicToolCall,
  parsePinnedCodexDynamicToolResponse,
  parsePinnedCodexDynamicToolSpec,
  type CodexExpiredServerRequestFault,
  type CodexJsonlSink,
  type CodexProtocolDiagnostic,
  type PinnedCodexDynamicToolProbeWitness,
  type PinnedCodexDynamicToolRequest,
  type PinnedCodexJsonValue,
} from "../src/codex";
import type {
  PinnedCodexDynamicToolEvidenceCustody,
  PinnedCodexDynamicToolProbeRuntimeBinding,
} from "../src/codex/dynamic-tool";
import {
  HRA_RLM_DYNAMIC_TOOL_SEMANTIC_CONTRACT_VERSION,
  HRA_RLM_DYNAMIC_TOOL_V1_SPEC_SHA256,
  HRA_RLM_PRE_ROUTING_INSPECT_DYNAMIC_TOOL_SPEC_SHA256,
  HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
  classifyHraRlmDynamicToolSpecDigest,
} from "../src/codex/dynamic-tool";
import { pinnedThreadFixture } from "./codex-pinned-fixtures";

const decoder = new TextDecoder();
const probeNowMs = Date.now();
const threadAdmissionFixture = Object.freeze({
  thread: pinnedThreadFixture,
  model: "gpt-5.6-sol",
  reasoningEffort: "max",
  serviceTier: null,
});
const v1ActorProgramFixture: PinnedCodexJsonValue = {
  version: 2,
  capabilities: ["agent.spawn", "agent.message"],
  steps: [
    {
      kind: "call",
      as: "child",
      operation: "agent.spawn",
      arguments: {
        title: { kind: "literal", value: "Inspect the bounded leaf" },
        workClass: { kind: "literal", value: "boundedLeaf" },
        allocation: {
          kind: "object",
          entries: {
            tokenShareBps: { kind: "literal", value: 5_000 },
            byteShareBps: { kind: "literal", value: 5_000 },
            activeDescendantShareBps: { kind: "literal", value: 5_000 },
            durableDescendantShareBps: { kind: "literal", value: 5_000 },
          },
        },
        inputValueId: {
          kind: "literal",
          value: "ctxval_primary_input",
        },
      },
    },
    {
      kind: "call",
      as: "turn",
      operation: "agent.send",
      arguments: {
        actorId: {
          kind: "field",
          value: { kind: "variable", name: "child" },
          field: "actorId",
        },
        inputValueId: {
          kind: "literal",
          value: "ctxval_followup_input",
        },
      },
    },
  ],
  result: { kind: "variable", name: "turn" },
};

class MemorySink implements CodexJsonlSink {
  readonly writes: string[] = [];

  write(bytes: Uint8Array): number {
    this.writes.push(decoder.decode(bytes));
    return bytes.byteLength;
  }
}

function probeEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = {
    schemaVersion: 1,
    kind: "oprte.codex.dynamic-tool.real-probe-witness",
    source: "signed-in-real-app-server",
    runId: "019fbd82-efa4-7542-af14-492556dcbcf7",
    startedAt: new Date(probeNowMs - 6 * 60 * 1_000).toISOString(),
    finishedAt: new Date(probeNowMs - 60 * 1_000).toISOString(),
    codexVersion: "0.144.6",
    binarySha256: "a".repeat(64),
    processGeneration: 17,
    registration: {
      initializeExperimentalApi: true,
      carrierMethod: "thread/start",
      paramsField: "dynamicTools",
      namespace: "oprte",
      tool: "rlm_run",
      specSha256: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
    },
    observations: {
      registrationAccepted: true,
      exactThreadAndTurnIdentity: true,
      successfulCompletion: true,
      failedCompletion: true,
      cancellationResolution: true,
      duplicateCallObserved: true,
      duplicateCallRejected: true,
      restartGenerationScoped: true,
    },
    ...overrides,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ...payload,
    evidenceObjectDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function evidenceBytes(evidence: Record<string, unknown>): Uint8Array {
  const { evidenceObjectDigest, ...payload } = evidence;
  void evidenceObjectDigest;
  return new TextEncoder().encode(JSON.stringify(payload));
}

function probeRuntime(
  processGeneration = 17,
  binarySha256 = "a".repeat(64),
  nowMs = probeNowMs,
): PinnedCodexDynamicToolProbeRuntimeBinding {
  return { processGeneration, binarySha256, nowMs };
}

function probeCustody(
  evidence: Record<string, unknown>,
): PinnedCodexDynamicToolEvidenceCustody {
  const digest = evidence.evidenceObjectDigest;
  if (typeof digest !== "string") throw new Error("fixture evidence digest is missing");
  const bytes = evidenceBytes(evidence);
  return {
    readVerifiedProbeEvidence: (input) => Promise.resolve(
      input.digest === digest ? { digest, bytes } : null,
    ),
  };
}

async function requiredWitness(
  processGeneration = 17,
): Promise<PinnedCodexDynamicToolProbeWitness> {
  const evidence = probeEvidence({ processGeneration });
  const witness = await acceptPinnedCodexDynamicToolProbeWitness(
    evidence,
    probeRuntime(processGeneration),
    probeCustody(evidence),
  );
  if (witness === null) throw new Error("fixture witness did not parse");
  return witness;
}

function callParams(
  argumentsValue: unknown = {
    schemaVersion: HRA_RLM_DYNAMIC_TOOL_SEMANTIC_CONTRACT_VERSION,
    action: "submit",
    program: v1ActorProgramFixture,
  },
) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: "oprte",
    tool: "rlm_run",
    arguments: argumentsValue,
  };
}

function parseWrites(sink: MemorySink): readonly Record<string, unknown>[] {
  return sink.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("pinned Codex dynamic tool codecs", () => {
  test("keeps predecessor digests recovery-only", () => {
    expect(HRA_RLM_DYNAMIC_TOOL_SEMANTIC_CONTRACT_VERSION).toBe(1);
    expect(HRA_RLM_DYNAMIC_TOOL_V1_SPEC_SHA256).toBe(
      "3e98e085a6bd241f257e161de4c9486c8490dda2c9675bf6d951188c2dc77ed5",
    );
    expect(HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256).toBe(
      HRA_RLM_DYNAMIC_TOOL_V1_SPEC_SHA256,
    );
    expect(HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256).not.toBe(
      HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
    );
    expect(classifyHraRlmDynamicToolSpecDigest(
      HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
      "fresh",
    )).toBe("current");
    expect(classifyHraRlmDynamicToolSpecDigest(
      HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
      "recovery",
    )).toBe("current");
    expect(classifyHraRlmDynamicToolSpecDigest(
      HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
      "fresh",
    )).toBeNull();
    expect(classifyHraRlmDynamicToolSpecDigest(
      HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
      "recovery",
    )).toBe("predecessorRecoveryOnly");
    expect(HRA_RLM_PRE_ROUTING_INSPECT_DYNAMIC_TOOL_SPEC_SHA256).toBe(
      "c8233c335cf93d1e8a412a5bfe81d71246b99fa120a58d4c29763caf6aac8fb4",
    );
    expect(classifyHraRlmDynamicToolSpecDigest(
      HRA_RLM_PRE_ROUTING_INSPECT_DYNAMIC_TOOL_SPEC_SHA256,
      "fresh",
    ))
      .toBeNull();
    expect(classifyHraRlmDynamicToolSpecDigest(
      HRA_RLM_PRE_ROUTING_INSPECT_DYNAMIC_TOOL_SPEC_SHA256,
      "recovery",
    ))
      .toBe("predecessorRecoveryOnly");
    expect(classifyHraRlmDynamicToolSpecDigest("0".repeat(64), "recovery"))
      .toBeNull();
  });

  test("registers the complete closed program lifecycle surface", () => {
    expect(parsePinnedCodexDynamicToolSpec(HRA_RLM_DYNAMIC_TOOL_SPEC))
      .not.toBeNull();
    const schema = HRA_RLM_DYNAMIC_TOOL_SPEC.tools[0].inputSchema;
    expect(Object.keys(schema.properties).sort()).toEqual([
      "action",
      "program",
      "runId",
      "schemaVersion",
      "timeoutMs",
    ]);
    expect(schema.required).toEqual(["schemaVersion", "action"]);
    expect("oneOf" in schema).toBeFalse();
    expect("anyOf" in schema).toBeFalse();
    expect("allOf" in schema).toBeFalse();
    expect("not" in schema).toBeFalse();
    expect(Object.isFrozen(HRA_RLM_DYNAMIC_TOOL_SPEC)).toBeTrue();
    expect(Object.isFrozen(HRA_RLM_DYNAMIC_TOOL_SPEC.tools)).toBeTrue();
    expect(Object.isFrozen(schema.properties.action.enum)).toBeTrue();
    expect(schema.$defs.rlmStep.properties.operation.enum).toContain("agent.spawn");
    expect(schema.$defs.rlmStep.properties.operation.enum).toContain("agent.send");
    expect(schema.$defs.rlmStep.properties.operation.enum).toContain("routing.inspect");
    expect(schema.$defs.rlmProgram.properties.capabilities.items.enum)
      .toContain("routing.inspect");
    expect(schema.$defs.rlmStep.properties.arguments.description).toContain(
      "agent.spawn {title,workClass:largeChange|wideResearch|standard|boundedLeaf,allocation:",
    );
    expect(schema.$defs.rlmStep.properties.arguments.description).toContain(
      "agent.send {actorId,inputValueId}",
    );
    expect(schema.$defs.rlmStep.properties.arguments.description).toContain(
      "HRA derives model, reasoning effort, and Fast or Standard from workClass",
    );
    expect(schema.$defs.rlmStep.properties.arguments.description).toContain(
      "routing.inspect {}",
    );
    expect(parsePinnedCodexDynamicToolCall(callParams())?.arguments).toEqual({
      schemaVersion: 1,
      action: "submit",
      program: v1ActorProgramFixture,
    });
  });

  test("accepts only the exact bounded oprte/rlm_run call and action combinations", () => {
    expect(parsePinnedCodexDynamicToolCall(callParams())).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "oprte",
      tool: "rlm_run",
    });
    expect(parsePinnedCodexDynamicToolCall({ ...callParams(), extra: true })).toBeNull();
    expect(parsePinnedCodexDynamicToolCall({ ...callParams(), namespace: null })).toBeNull();
    expect(parsePinnedCodexDynamicToolCall({ ...callParams(), tool: "shell.run" })).toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({
      schemaVersion: 1,
      action: "submit",
      program: { source: "x".repeat(256 * 1_024) },
    }))).toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({
      schemaVersion: 1,
      action: "submit",
      runId: "rlmrun_wrong",
      program: {},
    }))).toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({
      schemaVersion: 1,
      action: "status",
      runId: "rlmrun_ready",
      timeoutMs: 1,
    }))).toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({
      schemaVersion: 1,
      action: "wait",
      runId: "rlmrun_ready",
    }))).toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({
      schemaVersion: 1,
      action: "wait",
      runId: "rlmrun_ready",
      timeoutMs: 10,
    }))).not.toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({ __proto__: { unsafe: true } })))
      .toBeNull();
    const hostile = new Proxy({}, {
      get() { throw new Error("hostile getter"); },
      getPrototypeOf() { throw new Error("hostile prototype"); },
    });
    expect(parsePinnedCodexDynamicToolCall(hostile)).toBeNull();
    expect(parsePinnedCodexDynamicToolCall(callParams({
      schemaVersion: 1,
      action: "submit",
      program: hostile,
    }))).toBeNull();
  });

  test("accepts only bounded text responses with no unknown fields", () => {
    expect(parsePinnedCodexDynamicToolResponse({
      contentItems: [{ type: "inputText", text: "done" }],
      success: true,
    })).toEqual({
      contentItems: [{ type: "inputText", text: "done" }],
      success: true,
    });
    expect(parsePinnedCodexDynamicToolResponse({
      contentItems: [{ type: "inputImage", imageUrl: "https://example.com/private.png" }],
      success: true,
    })).toBeNull();
    expect(parsePinnedCodexDynamicToolResponse({
      contentItems: [],
      success: false,
      privateDetail: "must not cross",
    })).toBeNull();
  });

  test("requires authenticated readback and exact runtime binding for every lifecycle law", async () => {
    expect(Object.isFrozen(HRA_RLM_DYNAMIC_TOOL_SPEC)).toBeTrue();
    expect(Object.isFrozen(HRA_RLM_DYNAMIC_TOOL_SPEC.tools)).toBeTrue();
    expect(Object.isFrozen(
      HRA_RLM_DYNAMIC_TOOL_SPEC.tools[0].inputSchema.required,
    )).toBeTrue();
    const valid = probeEvidence();
    const accepted = await acceptPinnedCodexDynamicToolProbeWitness(
      valid,
      probeRuntime(),
      probeCustody(valid),
    );
    expect(accepted).not.toBeNull();
    expect(isPinnedCodexDynamicToolProbeWitness(accepted)).toBeFalse();
    expect(isPinnedCodexDynamicToolProbeWitness(accepted, probeRuntime())).toBeTrue();
    if (accepted === null) throw new Error("fixture witness was not accepted");
    const forged = Object.fromEntries(
      Reflect.ownKeys(accepted).map((key) => [key, Reflect.get(accepted, key)]),
    );
    expect(isPinnedCodexDynamicToolProbeWitness(forged, probeRuntime())).toBeFalse();
    expect(await acceptPinnedCodexDynamicToolProbeWitness(valid)).toBeNull();
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      valid,
      probeRuntime(),
      { readVerifiedProbeEvidence: () => Promise.resolve(null) },
    )).toBeNull();
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      valid,
      probeRuntime(),
      {
        readVerifiedProbeEvidence: ({ digest }) => Promise.resolve({
          digest,
          bytes: new TextEncoder().encode("{}"),
        }),
      },
    )).toBeNull();
    const incomplete = probeEvidence({
      observations: {
        ...(probeEvidence().observations as Record<string, unknown>),
        cancellationResolution: false,
      },
    });
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      incomplete,
      probeRuntime(),
      probeCustody(incomplete),
    )).toBeNull();
    const wrongVersion = probeEvidence({ codexVersion: "0.145.0" });
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      wrongVersion,
      probeRuntime(),
      probeCustody(wrongVersion),
    )).toBeNull();
    const wrongSpec = probeEvidence({
      registration: {
        ...(probeEvidence().registration as Record<string, unknown>),
        specSha256: "b".repeat(64),
      },
    });
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      wrongSpec,
      probeRuntime(),
      probeCustody(wrongSpec),
    )).toBeNull();
    const collidingField = probeEvidence({
      registration: {
        ...(probeEvidence().registration as Record<string, unknown>),
        paramsField: "fixtureDynamicTools",
      },
    });
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      collidingField,
      probeRuntime(),
      probeCustody(collidingField),
    )).toBeNull();
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      valid,
      probeRuntime(18),
      probeCustody(valid),
    )).toBeNull();
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      valid,
      probeRuntime(17, "b".repeat(64)),
      probeCustody(valid),
    )).toBeNull();
    expect(await acceptPinnedCodexDynamicToolProbeWitness(
      valid,
      probeRuntime(17, "a".repeat(64), probeNowMs + 11 * 60 * 1_000),
      probeCustody(valid),
    )).toBeNull();
  });
});

describe("pinned Codex dynamic tool admission", () => {
  test("injects the exact pinned spec only into witnessed thread/start", async () => {
    const plainSink = new MemorySink();
    const plain = new PinnedCodexProtocol(
      16,
      new CodexJsonlWriter(plainSink),
    );
    const plainStart = plain.request("threadStart", {
      cwd: "/tmp/oprte-dynamic",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    await Bun.sleep(0);
    const plainEnvelope = parseWrites(plainSink)[0];
    expect(plainEnvelope).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/tmp/oprte-dynamic",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
      },
    });
    const plainParams = plainEnvelope?.params;
    if (typeof plainParams !== "object" || plainParams === null) {
      throw new Error("plain thread/start params missing");
    }
    expect("dynamicTools" in plainParams).toBeFalse();
    if (typeof plainEnvelope?.id !== "string") throw new Error("plain request id missing");
    await plain.receiveValue(16, {
      id: plainEnvelope.id,
      result: threadAdmissionFixture,
    });
    await plainStart;
    expect(() => pinnedCodexRequests.threadStart.inputCodec.parse({
        cwd: "/tmp/oprte-dynamic",
        dynamicTools: [HRA_RLM_DYNAMIC_TOOL_SPEC],
      })).toThrow("Pinned Codex payload validation failed");
    expect(parseWrites(plainSink)).toHaveLength(1);

    const witnessedSink = new MemorySink();
    const witnessed = new PinnedCodexProtocol(
      17,
      new CodexJsonlWriter(witnessedSink),
      { onDynamicToolRequest: () => undefined },
      {
        dynamicTool: {
          witness: await requiredWitness(17),
          caller: { accountProfileId: "account-17", accountGeneration: 17 },
          runtimeBinarySha256: "a".repeat(64),
        },
        now: () => probeNowMs,
      },
    );
    const start = witnessed.request("threadStart", {
      cwd: "/tmp/oprte-dynamic",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    await Bun.sleep(0);
    const startEnvelope = parseWrites(witnessedSink)[0];
    expect(startEnvelope).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/tmp/oprte-dynamic",
        dynamicTools: [HRA_RLM_DYNAMIC_TOOL_SPEC],
      },
    });
    if (typeof startEnvelope?.id !== "string") throw new Error("start request id missing");
    await witnessed.receiveValue(17, {
      id: startEnvelope.id,
      result: threadAdmissionFixture,
    });
    await start;

    const resume = witnessed.request("threadResume", {
      threadId: "thread-1",
      cwd: "/tmp/oprte-dynamic",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    await Bun.sleep(0);
    const resumeEnvelope = parseWrites(witnessedSink)[1];
    expect(resumeEnvelope).toMatchObject({
      method: "thread/resume",
      params: { threadId: "thread-1", cwd: "/tmp/oprte-dynamic" },
    });
    const resumeParams = resumeEnvelope?.params;
    if (typeof resumeParams !== "object" || resumeParams === null) {
      throw new Error("thread/resume params missing");
    }
    expect("dynamicTools" in resumeParams).toBeFalse();
    if (typeof resumeEnvelope?.id !== "string") throw new Error("resume request id missing");
    await witnessed.receiveValue(17, {
      id: resumeEnvelope.id,
      result: threadAdmissionFixture,
    });
    await resume;
    expect(pinnedCodexRequests.threadResume.semantics.reconciliation).toEqual({
      kind: "unsupported",
      strategy: "thread-read",
    });
  });

  test("does not advertise dynamic tools without a bounded response callback", async () => {
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(
      19,
      new CodexJsonlWriter(sink),
      {},
      {
        dynamicTool: {
          witness: await requiredWitness(19),
          caller: { accountProfileId: "account-19", accountGeneration: 19 },
          runtimeBinarySha256: "a".repeat(64),
        },
        now: () => probeNowMs,
      },
    );
    const start = protocol.request("threadStart", {
      cwd: "/tmp/oprte-dynamic",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    await Bun.sleep(0);
    const envelope = parseWrites(sink)[0];
    const params = envelope?.params;
    if (typeof params !== "object" || params === null) {
      throw new Error("thread/start params missing");
    }
    expect("dynamicTools" in params).toBeFalse();
    if (typeof envelope?.id !== "string") throw new Error("request id missing");
    await protocol.receiveValue(19, {
      id: envelope.id,
      result: threadAdmissionFixture,
    });
    await start;
  });

  test("generated 0.144.6 registration remains disabled without a real-probe witness", async () => {
    const sink = new MemorySink();
    const observed: PinnedCodexDynamicToolRequest[] = [];
    const protocol = new PinnedCodexProtocol(7, new CodexJsonlWriter(sink), {
      onDynamicToolRequest: (request) => { observed.push(request); },
    });

    await protocol.receiveValue(7, {
      id: "unwitnessed",
      method: "item/tool/call",
      params: callParams(),
    });

    expect(observed).toEqual([]);
    expect(parseWrites(sink)).toEqual([{
      id: "unwitnessed",
      error: { code: -32_601, message: "Method not found" },
    }]);

    const mismatchedSink = new MemorySink();
    const mismatched = new PinnedCodexProtocol(
      8,
      new CodexJsonlWriter(mismatchedSink),
      {},
      {
        dynamicTool: {
          witness: await requiredWitness(8),
          caller: { accountProfileId: "account-1", accountGeneration: 1 },
          runtimeBinarySha256: "b".repeat(64),
        },
      },
    );
    await mismatched.receiveValue(8, {
      id: "mismatched-binary",
      method: "item/tool/call",
      params: callParams(),
    });
    expect(parseWrites(mismatchedSink)).toEqual([{
      id: "mismatched-binary",
      error: { code: -32_601, message: "Method not found" },
    }]);
  });

  test("preserves account, process, request, stream, and caller identity", async () => {
    const sink = new MemorySink();
    const observed: PinnedCodexDynamicToolRequest[] = [];
    const protocol = new PinnedCodexProtocol(
      17,
      new CodexJsonlWriter(sink),
      { onDynamicToolRequest: (request) => { observed.push(request); } },
      {
        dynamicTool: {
          witness: await requiredWitness(17),
          caller: { accountProfileId: "account-9", accountGeneration: 23 },
          runtimeBinarySha256: "a".repeat(64),
        },
      },
    );

    await protocol.receiveValue(17, {
      id: "provider-request-4",
      method: "item/tool/call",
      params: callParams(),
    });

    const request = observed[0];
    expect(request).toMatchObject({
      method: "item/tool/call",
      generation: 17,
      id: "provider-request-4",
      requestInstanceId: 1,
      streamPosition: 1,
      accountProfileId: "account-9",
      accountGeneration: 23,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "oprte",
        tool: "rlm_run",
      },
    });
    if (request === undefined) throw new Error("dynamic request was not routed");
    await protocol.respond(request, {
      type: "result",
      result: { contentItems: [{ type: "inputText", text: "ok" }], success: true },
    });
    expect(parseWrites(sink)).toEqual([{
      id: "provider-request-4",
      result: { contentItems: [{ type: "inputText", text: "ok" }], success: true },
    }]);
  });

  test("rejects duplicate calls and terminates a conflicting replay", async () => {
    const sink = new MemorySink();
    const observed: PinnedCodexDynamicToolRequest[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const protocol = new PinnedCodexProtocol(
      31,
      new CodexJsonlWriter(sink),
      {
        onDynamicToolRequest: (request) => { observed.push(request); },
        onServerRequestExpired: (fault) => { faults.push(fault); },
        onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
      },
      {
        dynamicTool: {
          witness: await requiredWitness(31),
          caller: { accountProfileId: "account-1", accountGeneration: 2 },
          runtimeBinarySha256: "a".repeat(64),
        },
      },
    );

    await protocol.receiveValue(31, {
      id: "first",
      method: "item/tool/call",
      params: callParams(),
    });
    const first = observed[0];
    if (first === undefined) throw new Error("first dynamic request was not routed");
    await protocol.respond(first, {
      type: "result",
      result: { contentItems: [], success: true },
    });
    await protocol.receiveValue(31, {
      id: "duplicate",
      method: "item/tool/call",
      params: callParams(),
    });
    expect(observed).toHaveLength(1);
    expect(faults).toContainEqual({
      type: "server_request_expired",
      generation: 31,
      method: "item/tool/call",
      requestId: "duplicate",
      reason: "duplicate_call",
    });

    await protocol.receiveValue(31, {
      id: "conflict",
      method: "item/tool/call",
      params: callParams({
        schemaVersion: 1,
        action: "submit",
        program: { changed: true },
      }),
    });
    expect(observed).toHaveLength(1);
    expect(faults).toContainEqual({
      type: "server_request_expired",
      generation: 31,
      method: "item/tool/call",
      requestId: "conflict",
      reason: "replay_conflict",
    });
    expect(diagnostics).toContainEqual({
      type: "invalid_inbound_payload",
      generation: 31,
      source: "server_request",
      method: "item/tool/call",
    });
  });

  test("scopes duplicate receipts to an exact process generation", () => {
    const parsed = parsePinnedCodexDynamicToolCall(callParams());
    if (parsed === null) throw new Error("call fixture did not parse");
    const firstGeneration = new PinnedCodexDynamicToolLedger();
    expect(firstGeneration.admit(1, parsed).kind).toBe("accepted");
    expect(firstGeneration.admit(1, parsed).kind).toBe("duplicate");
    expect(firstGeneration.admit(2, parsed).kind).toBe("accepted");
    const restartedProcess = new PinnedCodexDynamicToolLedger();
    expect(restartedProcess.admit(2, parsed).kind).toBe("accepted");
  });

  test("keeps response authority active after rejecting a malformed local result", async () => {
    const sink = new MemorySink();
    let observed: PinnedCodexDynamicToolRequest | undefined;
    const protocol = new PinnedCodexProtocol(
      41,
      new CodexJsonlWriter(sink),
      { onDynamicToolRequest: (request) => { observed = request; } },
      {
        dynamicTool: {
          witness: await requiredWitness(41),
          caller: { accountProfileId: "account-1", accountGeneration: 3 },
          runtimeBinarySha256: "a".repeat(64),
        },
      },
    );
    await protocol.receiveValue(41, {
      id: "response-contract",
      method: "item/tool/call",
      params: callParams(),
    });
    if (observed === undefined) throw new Error("dynamic request was not routed");
    expect(protocol.respond(observed, {
      type: "result",
      result: { contentItems: [], success: true, secret: "not allowed" },
    })).rejects.toThrow("pinned contract");
    await protocol.respond(observed, {
      type: "result",
      result: { contentItems: [], success: false },
    });
    expect(parseWrites(sink)).toEqual([{
      id: "response-contract",
      result: { contentItems: [], success: false },
    }]);
  });
});
