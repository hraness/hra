import { describe, expect, test } from "bun:test";

import type { CloudPayloadAuthority, DeviceCommandResultPayload } from "../hra/cloud";
import { readDeviceCommandResult } from "./device-commands";

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
