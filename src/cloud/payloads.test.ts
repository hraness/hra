import { describe, expect, test } from "bun:test";

import { randomKeyBytes } from "./crypto";
import {
  decryptRemoteCommand,
  encryptRemoteCommand,
  parseRemoteCommandPayload,
  parseSessionMetadataPayload,
} from "./payloads";
import { expectPromiseToReject } from "./testAssertions";

describe("closed encrypted payloads", () => {
  test("rejects generic RPC and provider method smuggling", () => {
    const absoluteSecretPath = ["", "Users", "name", ".ssh"].join("/");
    expect(parseRemoteCommandPayload({ kind: "rpc", method: "danger" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "send", message: "hello", method: "raw" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "unknown" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "steer", message: `read ${absoluteSecretPath}` }))
      .toBeNull();
  });

  test("keeps exactly one bounded note and name", () => {
    expect(parseSessionMetadataPayload({ name: "Work", note: "Remember this" }))
      .toEqual({ name: "Work", note: "Remember this" });
    expect(parseSessionMetadataPayload({ name: "Work", note: "x", secondNote: "y" }))
      .toBeNull();
  });

  test("remote commands round trip only under their entity authority", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "command_12345678",
      keyVersion: 1,
      kind: "command",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptRemoteCommand({ kind: "set_fast", enabled: true }, key, authority);
    expect(await decryptRemoteCommand(envelope, key, authority))
      .toEqual({ kind: "set_fast", enabled: true });
    await expectPromiseToReject(decryptRemoteCommand(envelope, key, {
      ...authority,
      entityPublicId: "command_87654321",
    }));
  });
});
