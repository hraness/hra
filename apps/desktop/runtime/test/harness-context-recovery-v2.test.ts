import { describe, expect, test } from "bun:test";

import {
  HarnessContextRecoveryV2,
  HarnessContextRecoveryV2Error,
  type HarnessContextRecoveryStoreV2,
} from "../src/harness/context-recovery-v2";

const digest = "a".repeat(64);

function record(
  ordinal: number,
  state: "prepared" | "effectStarted" | "replayRequired" | "recoveryRequired",
) {
  const suffix = String(ordinal).padStart(8, "0");
  return {
    version: 2 as const,
    operationId: `recovery_operation_${suffix}`,
    epochId: `hepoch_recovery_${suffix}`,
    ownerActorId: `hactor_recovery_${suffix}`,
    sourceTurnId: null,
    valueId: `ctxval_recovery_${suffix}`,
    kind: "text" as const,
    purpose: "heap" as const,
    schemaVersion: 1 as const,
    nameDigest: null,
    utf8Bytes: 1,
    contentDigest: digest,
    chunkSize: 65_536 as const,
    chunkCount: 1,
    chunks: [{
      ordinal: 0,
      plaintextBytes: 1,
      objectDigest: digest,
      objectByteLength: 1,
    }],
    manifestDigest: digest,
    manifestByteLength: 1,
    quotaLimitBytes: 1024 * 1024,
    state,
    recoveryReason: state === "recoveryRequired"
      ? "metadata_conflict" as const
      : null,
    revision: 1,
  };
}

describe("HarnessContextRecoveryV2", () => {
  test("pages once through recovery rows and classifies exact outcomes", async () => {
    const source = [
      record(1, "prepared"),
      record(2, "effectStarted"),
      record(3, "recoveryRequired"),
    ];
    const observed: string[] = [];
    const store: HarnessContextRecoveryStoreV2 = {
      scanRecovery: ({ afterOperationId, limit }) => Promise.resolve(source
        .filter(({ operationId }) =>
          afterOperationId === null || operationId > afterOperationId
        )
        .slice(0, limit)),
      recover: (operationId) => {
        observed.push(operationId);
        const current = source.find((value) => value.operationId === operationId)!;
        if (current.state === "effectStarted") {
          return Promise.resolve({
            state: "replayRequired",
            value: { ...current, state: "replayRequired", revision: 2 },
          });
        }
        return Promise.resolve({ state: current.state, value: current });
      },
    };
    const recovery = new HarnessContextRecoveryV2({
      store,
      pageSize: 2,
      maxRecords: 3,
    });

    const report = await recovery.recover();

    expect(report.inspectedOperationIds).toEqual(observed);
    expect(report.preparedOperationIds).toEqual([source[0]!.operationId]);
    expect(report.replayRequiredOperationIds).toEqual([source[1]!.operationId]);
    expect(report.recoveryRequiredOperationIds).toEqual([source[2]!.operationId]);
    expect(report.activeOperationIds).toEqual([]);
  });

  test("rejects duplicate pages and a scan beyond its declared bound", () => {
    const duplicate = record(1, "prepared");
    const duplicated: HarnessContextRecoveryStoreV2 = {
      scanRecovery: () => Promise.resolve([duplicate, duplicate]),
      recover: () => Promise.reject(new Error("must not recover")),
    };
    expect(new HarnessContextRecoveryV2({
      store: duplicated,
      pageSize: 2,
    }).recover()).rejects.toBeInstanceOf(HarnessContextRecoveryV2Error);

    const values = [record(1, "prepared"), record(2, "prepared")];
    const bounded: HarnessContextRecoveryStoreV2 = {
      scanRecovery: ({ afterOperationId, limit }) => Promise.resolve(values
        .filter(({ operationId }) =>
          afterOperationId === null || operationId > afterOperationId
        )
        .slice(0, limit)),
      recover: (operationId) => Promise.resolve({
        state: "prepared",
        value: values.find((value) => value.operationId === operationId),
      }),
    };
    expect(new HarnessContextRecoveryV2({
      store: bounded,
      pageSize: 1,
      maxRecords: 1,
    }).recover()).rejects.toMatchObject({ code: "bound_exceeded" });
  });
});
