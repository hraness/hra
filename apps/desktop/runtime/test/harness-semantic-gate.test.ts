import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  HARNESS_SEMANTIC_PROVIDER_ID,
  SemanticHarnessFeatureGate,
  decideHarnessFeature,
  requiredHarnessSemantics,
  verifyHarnessSemanticWitness,
  type HarnessSemanticEvidenceCustody,
  type HarnessFeatureRequestBinding,
  type HarnessSemanticId,
  type HarnessSemanticRuntimeBinding,
  type VerifiedHarnessSemanticWitness,
} from "../src/harness/semantic-gate";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const runtime: HarnessSemanticRuntimeBinding = {
  requestInstanceId: 1,
  providerId: HARNESS_SEMANTIC_PROVIDER_ID,
  codexVersion: "0.144.6",
  accountProfileId: "acct_semantic01",
  accountGeneration: 7,
  binarySha256: digest("c"),
  processGeneration: 7,
  nowMs: Date.parse("2026-08-05T12:05:00.000Z"),
};
const requestBinding: HarnessFeatureRequestBinding = {
  requestInstanceId: runtime.requestInstanceId,
  accountProfileId: runtime.accountProfileId,
  accountGeneration: runtime.accountGeneration,
  processGeneration: runtime.processGeneration,
};

function evidence(semantic: HarnessSemanticId, state: "proven" | "unsupported" | "inconclusive" = "proven") {
  const payload = {
    version: 1 as const,
    providerId: HARNESS_SEMANTIC_PROVIDER_ID,
    semantic,
    codexVersion: "0.144.6" as const,
    state,
    probeId: `probe-${semantic.toLowerCase()}`,
    probeDigest: digest("a"),
    observedAt: "2026-08-05T12:00:00.000Z",
    accountProfileId: runtime.accountProfileId,
    accountGeneration: runtime.accountGeneration,
    binarySha256: runtime.binarySha256,
    processGeneration: runtime.processGeneration,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    witness: {
      ...payload,
      evidenceObjectDigest: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes,
  };
}

function custodyFor(
  entries: readonly ReturnType<typeof evidence>[],
): HarnessSemanticEvidenceCustody {
  const byDigest = new Map(entries.map(({ witness, bytes }) => [
    witness.evidenceObjectDigest,
    bytes,
  ]));
  return {
    readVerifiedEvidenceObject: ({ digest: evidenceDigest }) =>
      Promise.resolve(byDigest.has(evidenceDigest)
        ? { digest: evidenceDigest, bytes: byDigest.get(evidenceDigest)! }
        : null),
  };
}

async function verified(
  entries: readonly ReturnType<typeof evidence>[],
): Promise<readonly VerifiedHarnessSemanticWitness[]> {
  const custody = custodyFor(entries);
  const witnesses = await Promise.all(entries.map(({ witness }) =>
    verifyHarnessSemanticWitness(witness, runtime, custody)
  ));
  return witnesses.flatMap((witness) => witness === null ? [] : [witness]);
}

describe("recursive harness semantic admission", () => {
  test("one exact runtime and witness snapshot decides a related feature set", async () => {
    const semantics = [...new Set([
      ...requiredHarnessSemantics("boundedPrograms"),
      ...requiredHarnessSemantics("contextReferences"),
    ])];
    const entries = semantics.map((semantic) => evidence(semantic));
    let runtimeReads = 0;
    let witnessReads = 0;
    const gate = new SemanticHarnessFeatureGate({
      evidence: custodyFor(entries),
      runtime: {
        resolveBinding: () => {
          runtimeReads += 1;
          return Promise.resolve(runtime);
        },
      },
      witnesses: {
        listWitnesses: () => {
          witnessReads += 1;
          return Promise.resolve(entries.map(({ witness }) => witness));
        },
      },
    });

    expect(await gate.decideMany([
      "boundedPrograms",
      "contextReferences",
      "boundedPrograms",
    ], requestBinding)).toEqual([
      expect.objectContaining({ enabled: true, feature: "boundedPrograms" }),
      expect.objectContaining({ enabled: true, feature: "contextReferences" }),
    ]);
    expect(runtimeReads).toBe(1);
    expect(witnessReads).toBe(1);
  });

  test("invalid or mismatched runtime bindings fail before witness lookup", async () => {
    let runtimeReads = 0;
    let witnessReads = 0;
    const gate = new SemanticHarnessFeatureGate({
      evidence: {
        readVerifiedEvidenceObject: () =>
          Promise.reject(new Error("evidence must stay unreachable")),
      },
      runtime: {
        resolveBinding: () => {
          runtimeReads += 1;
          return Promise.resolve({ ...runtime, requestInstanceId: 2 });
        },
      },
      witnesses: {
        listWitnesses: () => {
          witnessReads += 1;
          return Promise.resolve([]);
        },
      },
    });

    expect(await gate.decide("boundedPrograms", {
      ...requestBinding,
      processGeneration: requestBinding.processGeneration + 1,
    })).toEqual({
      enabled: false,
      feature: "boundedPrograms",
      reason: "runtime_binding_unavailable",
    });
    expect(runtimeReads).toBe(0);
    expect(await gate.decide("boundedPrograms", requestBinding)).toEqual({
      enabled: false,
      feature: "boundedPrograms",
      reason: "runtime_binding_unavailable",
    });
    expect(runtimeReads).toBe(1);
    expect(witnessReads).toBe(0);
  });

  test("keeps bounded programs disabled until every exact pinned witness exists", async () => {
    expect(decideHarnessFeature("boundedPrograms", [], runtime)).toMatchObject({
      enabled: false,
      reason: "missing_witness",
    });
    const semantics = requiredHarnessSemantics("boundedPrograms");
    const entries = semantics.map((semantic) => evidence(semantic));
    expect(decideHarnessFeature(
      "boundedPrograms",
      await verified(entries),
      runtime,
    )).toEqual({
      enabled: true,
      feature: "boundedPrograms",
      witnessDigests: [...new Set(entries.map(({ witness }) =>
        witness.evidenceObjectDigest
      ))].sort(),
    });
  });

  test("a conflicting or unsupported observation disables admission", async () => {
    const semantics = requiredHarnessSemantics("boundedPrograms");
    const proven = semantics.map((semantic) => evidence(semantic));
    expect(decideHarnessFeature("boundedPrograms", [
      ...await verified([
        ...proven,
        evidence("program.dynamicToolLifecycle", "unsupported"),
      ]),
    ], runtime)).toMatchObject({ enabled: false, reason: "conflicting_witness" });
    expect(decideHarnessFeature("boundedPrograms", await verified(
      semantics.map((semantic) => evidence(
        semantic,
        semantic === "program.exactCallerBinding" ? "unsupported" : "proven",
      )),
    ), runtime)).toMatchObject({ enabled: false, reason: "unsupported" });
  });

  test("arbitrary JSON, missing readback, stale generations, and stale time stay disabled", async () => {
    const entry = evidence("history.completedCoverage");
    expect(decideHarnessFeature(
      "contextReferences",
      [entry.witness],
      runtime,
    )).toMatchObject({ enabled: false, reason: "missing_witness" });
    expect(await verifyHarnessSemanticWitness(entry.witness, runtime, {
      readVerifiedEvidenceObject: () => Promise.resolve(null),
    })).toBeNull();
    expect(await verifyHarnessSemanticWitness(entry.witness, runtime, {
      readVerifiedEvidenceObject: ({ digest: evidenceDigest }) => Promise.resolve({
        digest: evidenceDigest,
        bytes: new TextEncoder().encode("{}"),
      }),
    })).toBeNull();
    expect(await verifyHarnessSemanticWitness(entry.witness, {
      ...runtime,
      processGeneration: runtime.processGeneration + 1,
    }, custodyFor([entry]))).toBeNull();
    expect(await verifyHarnessSemanticWitness(entry.witness, {
      ...runtime,
      nowMs: runtime.nowMs + 11 * 60 * 1_000,
    }, custodyFor([entry]))).toBeNull();
    expect(await verifyHarnessSemanticWitness(entry.witness, {
      ...runtime,
      providerId: "another-provider",
    }, custodyFor([entry]))).toBeNull();
    expect(await verifyHarnessSemanticWitness(entry.witness, {
      ...runtime,
      codexVersion: "0.145.0",
    }, custodyFor([entry]))).toBeNull();
    const trusted = await verified([entry]);
    expect(decideHarnessFeature("contextReferences", trusted)).toMatchObject({
      enabled: false,
      reason: "missing_witness",
    });
    expect(decideHarnessFeature("contextReferences", trusted, {
      ...runtime,
      binarySha256: digest("d"),
    })).toMatchObject({ enabled: false, reason: "missing_witness" });
    const source = trusted[0];
    if (source === undefined) throw new Error("fixture witness was not verified");
    const forged = Object.fromEntries(
      Reflect.ownKeys(source).map((key) => [key, Reflect.get(source, key)]),
    );
    expect(decideHarnessFeature("contextReferences", [forged], runtime))
      .toMatchObject({ enabled: false, reason: "missing_witness" });
  });
});
