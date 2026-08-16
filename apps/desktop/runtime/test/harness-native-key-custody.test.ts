import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  harnessInstallKeyDescriptor,
  harnessLegacyInstallKeyDescriptor,
  serializeHarnessInstallMaster,
} from "../src/harness/key-custody";
import {
  NativeHarnessKeyCustody,
  nativeHarnessCustodyFailureStage,
  nativeHarnessCustodyFailureLegacySubstage,
  nativeHarnessCustodyFailureStageSchema,
  nativeHarnessCustodyResultSchema,
  nativeLegacyHarnessCustodyFailureSubstageSchema,
  nativeLegacyHarnessCustodyFailureSubstages,
  type NativeHarnessCustodyRequestEnvelope,
} from "../src/harness/native-key-custody";
import {
  nativeLegacyHarnessCustodyFailureStages,
} from "../src/harness/native-key-custody-protocol";

async function expectCustodyUnavailable(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code: "custody_unavailable" });
    return;
  }
  throw new Error("expected native Harness custody to fail closed");
}

function envelope(marker: number): string {
  return serializeHarnessInstallMaster(new Uint8Array(32).fill(marker));
}

async function nextRequest(
  requests: NativeHarnessCustodyRequestEnvelope[],
): Promise<NativeHarnessCustodyRequestEnvelope> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = requests.shift();
    if (request !== undefined) return request;
    await Promise.resolve();
  }
  throw new Error("Native Harness request was not written");
}

describe("native Harness Keychain custody client", () => {
  test("reads migrated v2 custody through a fixed descriptor and exact correlation", async () => {
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const pending = custody.get(harnessInstallKeyDescriptor);
    const request = await nextRequest(requests);
    expect(request.kind).toBe("harnessCustodyNativeRequest");
    expect(request.version).toBe(1);
    expect(request.request.action).toBe("read");
    expect(request.request.id).toMatch(/^native-harness-[a-f0-9]{24}$/u);
    expect(request.request.binding).toMatch(/^binding_[a-f0-9]{48}$/u);
    expect(request.request.deadlineUnixMilliseconds).toBeGreaterThan(
      Date.now(),
    );
    expect(request.request.deadlineUnixMilliseconds - Date.now()).toBeLessThanOrEqual(
      50_000,
    );
    expect(JSON.stringify(request)).not.toContain("context-heap");
    expect(JSON.stringify(request)).not.toContain("installation-master");
    expect(custody.complete({
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "read",
      ok: true,
      state: "present",
      value: envelope(7),
      migratedFromLegacy: true,
      legacyPreserved: true,
    })).toBeTrue();
    expect(await pending).toBe(envelope(7));
  });

  test("reports migration evidence without returning the key envelope", async () => {
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const pending = custody.ensureMigrated();
    const request = await nextRequest(requests);
    const value = envelope(9);
    expect(custody.complete({
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "read",
      ok: true,
      state: "present",
      value,
      migratedFromLegacy: true,
      legacyPreserved: true,
    })).toBeTrue();
    const observation = await pending;
    expect(observation).toEqual({
      state: "present",
      migratedFromLegacy: true,
      legacyPreserved: true,
      digest: createHash("sha256").update(value, "utf8").digest("hex"),
    });
    expect(JSON.stringify(observation)).not.toContain(value);
  });

  test("fails closed on a conflicting set-if-absent readback", async () => {
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const pending = custody.set({
      ...harnessInstallKeyDescriptor,
      value: envelope(3),
    });
    const request = await nextRequest(requests);
    expect(request.request).toMatchObject({
      action: "setIfAbsent",
      value: envelope(3),
    });
    expect(custody.complete({
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "setIfAbsent",
      ok: true,
      value: envelope(4),
      created: false,
    })).toBeTrue();
    await expectCustodyUnavailable(pending);
  });

  test("keeps delete-both behind the authenticated removal method", async () => {
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    await expectCustodyUnavailable(custody.delete(harnessInstallKeyDescriptor));
    await expectCustodyUnavailable(custody.get(harnessLegacyInstallKeyDescriptor));

    const pending = custody.deleteBothForAuthenticatedRemoval({
      operationId: "op_removal01",
      previewId: "removal_example1",
      nativeRemovalCapability: "ab".repeat(32),
      receiptAuthentication: `hmac_sha256_${"cd".repeat(32)}`,
    });
    const request = await nextRequest(requests);
    expect(request.request).toMatchObject({
      action: "deleteBoth",
      removalCapability: "ab".repeat(32),
      operationId: "op_removal01",
      previewId: "removal_example1",
    });
    expect(JSON.stringify(request)).not.toContain("receiptAuthentication");
    expect(custody.complete({
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "deleteBoth",
      ok: true,
      deletedV1: true,
      deletedV2: true,
      absentV1: true,
      absentV2: true,
    })).toBeTrue();
    expect(await pending).toBeTrue();
  });

  test("rejects malformed, replayed, or mismatched native results", async () => {
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const pending = custody.get(harnessInstallKeyDescriptor);
    const request = await nextRequest(requests);
    const result = {
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "read",
      ok: true,
      state: "absent",
      value: null,
      migratedFromLegacy: false,
      legacyPreserved: false,
    } as const;
    expect(custody.complete({ ...result, binding: `binding_${"f".repeat(48)}` }))
      .toBeFalse();
    expect(custody.complete({ ...result, extra: true })).toBeFalse();
    expect(custody.complete(result)).toBeTrue();
    expect(custody.complete(result)).toBeFalse();
    expect(await pending).toBeNull();
  });

  test("accepts only the closed native failure-stage vocabulary without widening the public error", async () => {
    const stages = nativeHarnessCustodyFailureStageSchema.options;
    expect(new Set(stages).size).toBe(stages.length);
    expect(stages).toEqual([
      "admission",
      "marker_read",
      "envelope_read",
      "legacy_read",
      "marker_prepare",
      "envelope_set_if_absent",
      "legacy_preservation_read",
      "marker_commit",
      "legacy_delete",
      "envelope_delete",
      "marker_delete",
      "reconciliation",
      "reporting",
    ]);
    expect(nativeLegacyHarnessCustodyFailureSubstageSchema.options).toEqual(
      [...nativeLegacyHarnessCustodyFailureSubstages],
    );
    expect(nativeLegacyHarnessCustodyFailureStages).toEqual([
      "legacy_read",
      "legacy_preservation_read",
      "legacy_delete",
    ]);
    expect(new Set(nativeLegacyHarnessCustodyFailureSubstages).size).toBe(
      nativeLegacyHarnessCustodyFailureSubstages.length,
    );
    expect(nativeLegacyHarnessCustodyFailureSubstages).toEqual([
      "admission",
      "static_bundle",
      "static_self_managed",
      "static_security_metadata",
      "spawn",
      "descriptor_before_dynamic",
      "dynamic_pid_hash",
      "dynamic_security_metadata",
      "descriptor_after_dynamic",
      "resume",
      "output",
      "exit",
      "group_retirement",
      "response_parse",
    ]);
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const pending = custody.ensureMigrated();
    const request = await nextRequest(requests);
    const failure = {
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "read",
      ok: false,
      failureStage: "legacy_read",
      legacySubstage: "dynamic_pid_hash",
    } as const;
    expect(nativeHarnessCustodyResultSchema.safeParse(failure).success).toBeTrue();
    for (const legacySubstage of nativeLegacyHarnessCustodyFailureSubstages) {
      for (const failureStage of nativeLegacyHarnessCustodyFailureStages) {
        const serialized = JSON.stringify({
          ...failure,
          failureStage,
          legacySubstage,
        });
        expect(
          nativeHarnessCustodyResultSchema.safeParse(JSON.parse(serialized))
            .success,
        ).toBeTrue();
        expect(serialized).not.toContain("/private/");
        expect(serialized).not.toContain("OSStatus");
      }
    }
    expect(nativeHarnessCustodyResultSchema.safeParse({
      ...failure,
      failureStage: "raw_helper_error",
    }).success).toBeFalse();
    expect(nativeHarnessCustodyResultSchema.safeParse({
      ...failure,
      failureStage: undefined,
    }).success).toBeFalse();
    expect(nativeHarnessCustodyResultSchema.safeParse({
      ...failure,
      legacySubstage: undefined,
    }).success).toBeFalse();
    expect(nativeHarnessCustodyResultSchema.safeParse({
      ...failure,
      legacySubstage: null,
    }).success).toBeFalse();
    for (const legacySubstage of [
      "raw_helper_error",
      "/private/tmp/oprte-gateway",
      "OSStatus -25300",
      -25300,
      { status: -25300 },
    ]) {
      expect(nativeHarnessCustodyResultSchema.safeParse({
        ...failure,
        legacySubstage,
      }).success).toBeFalse();
    }
    const ordinaryFailure = {
      kind: failure.kind,
      version: failure.version,
      nativeRequestId: failure.nativeRequestId,
      binding: failure.binding,
      action: failure.action,
      ok: failure.ok,
      failureStage: "admission",
    } as const;
    expect(nativeHarnessCustodyResultSchema.safeParse(ordinaryFailure).success)
      .toBeTrue();
    expect(nativeHarnessCustodyResultSchema.safeParse({
      ...ordinaryFailure,
      legacySubstage: "admission",
    }).success).toBeFalse();
    expect(nativeHarnessCustodyResultSchema.safeParse({
      ...failure,
      detail: "/private/path and OSStatus -25300",
    }).success).toBeFalse();
    expect(custody.complete(failure)).toBeTrue();
    let error: unknown;
    try {
      await pending;
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "custody_unavailable" });
    expect(nativeHarnessCustodyFailureStage(error)).toBe("legacy_read");
    expect(nativeHarnessCustodyFailureLegacySubstage(error)).toBe(
      "dynamic_pid_hash",
    );
    expect(error).not.toHaveProperty("failureStage");
    expect(error).not.toHaveProperty("legacySubstage");
    expect(String(error)).not.toContain("legacy_read");
    expect(String(error)).not.toContain("dynamic_pid_hash");

    const ordinaryPending = custody.get(harnessInstallKeyDescriptor);
    const ordinaryRequest = await nextRequest(requests);
    expect(custody.complete({
      ...ordinaryFailure,
      nativeRequestId: ordinaryRequest.request.id,
      binding: ordinaryRequest.request.binding,
    })).toBeTrue();
    let ordinaryError: unknown;
    try {
      await ordinaryPending;
    } catch (caught: unknown) {
      ordinaryError = caught;
    }
    expect(ordinaryError).toMatchObject({ code: "custody_unavailable" });
    expect(nativeHarnessCustodyFailureStage(ordinaryError)).toBe("admission");
    expect(nativeHarnessCustodyFailureLegacySubstage(ordinaryError)).toBeNull();
    expect(ordinaryError).not.toHaveProperty("failureStage");
    expect(ordinaryError).not.toHaveProperty("legacySubstage");
  });

  test("expires the Native mutation fence before abandoning its reporter", async () => {
    const requests: NativeHarnessCustodyRequestEnvelope[] = [];
    const custody = new NativeHarnessKeyCustody({
      timeoutMs: 20,
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const pending = custody.get(harnessInstallKeyDescriptor);
    const request = await nextRequest(requests);
    const remaining = request.request.deadlineUnixMilliseconds - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(20);
    await expectCustodyUnavailable(pending);
    expect(custody.complete({
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId: request.request.id,
      binding: request.request.binding,
      action: "read",
      ok: true,
      state: "absent",
      value: null,
      migratedFromLegacy: false,
      legacyPreserved: false,
    })).toBeFalse();
  });
});
