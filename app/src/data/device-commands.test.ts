import { describe, expect, test } from "bun:test";

import type { CloudPayloadAuthority, DeviceCommandResultPayload } from "../hra/cloud";
import {
  consumeSingleUseDeviceCommandResult,
  DeviceCommandConsumePrecommitError,
  deviceCommandMutationFailureCause,
  DeviceCommandResponseInvalidError,
  readDeviceCommandResult,
  submitPreparedDeviceCommand,
} from "./device-commands";
import type { WireDeviceEnqueueArgs } from "./functions";

const publicId = "018bcfe5-6800-7000-8000-000000000001";
const receipt = {
  idempotencyKey: "018bcfe5-6800-7000-8000-000000000002",
  publicId,
  requestDigest: "a".repeat(64),
};
const enqueueRequest: WireDeviceEnqueueArgs = {
  deadline: 1_760_000_060_000,
  expectedTargetDevicePublicId: "device_daemon01",
  idempotencyKey: receipt.idempotencyKey,
  kind: "usage_refresh",
  payload: {
    algorithm: "A256GCM",
    ciphertext: "AA",
    keyVersion: 7,
    nonce: "AAAAAAAAAAAAAAAA",
  },
  publicId,
  requestDigest: receipt.requestDigest,
};

function productionMutationError(functionName: string, code: string): Error {
  return new Error(
    `[CONVEX M(${functionName})] Uncaught Error: ${code}\n`
      + "    at handler (../convex/deviceCommands.ts:1:1)\n"
      + "  Called by client",
  );
}

describe("device command result reads", () => {
  test("decrypts a reusable status under the exact result authority", async () => {
    const expected: DeviceCommandResultPayload = {
      instruction: "A login is in progress. Finish it or cancel it from the machine.",
      kind: "account_login_status",
      status: "pending",
    };
    let observedAuthority: CloudPayloadAuthority | undefined;
    const actual = await readDeviceCommandResult({
      commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
      envelope: {
        algorithm: "A256GCM",
        ciphertext: "AA",
        keyVersion: 7,
        nonce: "AAAAAAAAAAAAAAAA",
      },
      key: new Uint8Array(32),
      keyVersion: 7,
      userPublicId: "user_0000000000000001",
    }, async (_envelope, _key, authority) => {
      observedAuthority = authority;
      return expected;
    });

    expect(actual).toEqual(expected);
    expect(observedAuthority).toEqual({
      entityPublicId: "018bcfe5-6800-7000-8000-000000000001",
      keyVersion: 7,
      kind: "device_command_result",
      userPublicId: "user_0000000000000001",
    });
  });
});

describe("device command submission transport contract", () => {
  for (const code of [
    "DEVICE_AUTHORITY_INVALID",
    "DEVICE_COMMAND_TARGET_NOT_EXECUTOR",
    "IDEMPOTENCY_CONFLICT",
  ]) {
    test(`preserves the production plain Error for ${code} without a second enqueue`, async () => {
      const failure = productionMutationError("deviceCommands:enqueue", code);
      let calls = 0;
      await expect(submitPreparedDeviceCommand(enqueueRequest, async () => {
        calls += 1;
        throw failure;
      })).rejects.toBe(failure);
      expect(calls).toBe(1);
    });
  }

  test("keeps one application call pending while the Convex client reconciles transport loss", async () => {
    let calls = 0;
    let settle: ((value: unknown) => void) | undefined;
    const clientMutation = new Promise<unknown>((resolve) => { settle = resolve; });
    const submitted = submitPreparedDeviceCommand(enqueueRequest, async () => {
      calls += 1;
      return await clientMutation;
    });

    await Promise.resolve();
    expect(calls).toBe(1);
    settle?.({ publicId, replay: false, state: "pending" });
    expect(await submitted).toBe(publicId);
    expect(calls).toBe(1);
  });

  test("fails closed on a malformed successful response without a second enqueue", async () => {
    let calls = 0;
    let failure: unknown;
    try {
      await submitPreparedDeviceCommand(enqueueRequest, async () => {
        calls += 1;
        return { publicId: "018bcfe5-6800-7000-8000-000000000099" };
      });
    } catch (caught: unknown) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(DeviceCommandResponseInvalidError);
    expect((failure as DeviceCommandResponseInvalidError).commandPublicId).toBe(publicId);
    expect(failure).not.toHaveProperty("request");
    expect(failure).not.toHaveProperty("payload");
    expect(calls).toBe(1);
  });
});

describe("single-use result fencing", () => {
  test("marks a production plain handler refusal as safe for an explicit retry", async () => {
    const refusal = productionMutationError(
      "deviceCommands:consumeResult",
      "DEVICE_COMMAND_RESULT_NOT_SINGLE_USE",
    );
    let calls = 0;
    let failure: unknown;
    try {
      await consumeSingleUseDeviceCommandResult(publicId, async () => {
        calls += 1;
        throw refusal;
      });
    } catch (caught: unknown) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(DeviceCommandConsumePrecommitError);
    expect((failure as DeviceCommandConsumePrecommitError).failure).toBe(refusal);
    expect(calls).toBe(1);
  });

  test("keeps one exchange pending while the Convex client reconciles transport loss", async () => {
    let calls = 0;
    let settle: ((value: unknown) => void) | undefined;
    const released = { publicId, result: enqueueRequest.payload, status: "released" };
    const clientMutation = new Promise<unknown>((resolve) => { settle = resolve; });
    const consumed = consumeSingleUseDeviceCommandResult(publicId, async () => {
      calls += 1;
      return await clientMutation;
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    settle?.(released);
    expect(await consumed).toBe(released);
    expect(calls).toBe(1);
  });

  test("returns the one successful exchange response unchanged", async () => {
    const released = { publicId, status: "spent" };
    expect(await consumeSingleUseDeviceCommandResult(
      publicId,
      async () => released,
    )).toBe(released);
  });

  test("keeps the underlying Convex failure visible to custody reporting", () => {
    const authorityFailure = productionMutationError(
      "deviceCommands:consumeResult",
      "DEVICE_AUTHORITY_INVALID",
    );
    expect(deviceCommandMutationFailureCause(
      new DeviceCommandConsumePrecommitError(authorityFailure),
    )).toBe(authorityFailure);
    expect(deviceCommandMutationFailureCause(authorityFailure)).toBe(authorityFailure);
  });
});
