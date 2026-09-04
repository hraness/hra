import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../hra/cloud";
import {
  newConnectionId,
  nextPresenceSequence,
  presenceArgs,
  presenceFingerprint,
  type PresenceIdentity,
} from "./presence";

const identity: PresenceIdentity = {
  authEpoch: 3,
  credentialGeneration: 1,
  devicePublicId: "device_0123456789abcdef",
  userPublicId: "user_0123456789abcdef",
};
const connectionId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("presenceFingerprint", () => {
  test("is the daemon's presence digest", async () => {
    const expected = await sha256Hex([
      "hra-control-plane-cloud-presence:v1",
      identity.userPublicId,
      "3",
      identity.devicePublicId,
      "1",
      connectionId,
      "connect",
      "0",
    ].join("\n"));
    expect(await presenceFingerprint({ connectionId, identity, kind: "connect", sequence: 0 }))
      .toBe(expected);
  });

  test("binds the kind and the sequence", async () => {
    const connect = await presenceFingerprint({
      connectionId,
      identity,
      kind: "connect",
      sequence: 0,
    });
    const heartbeat = await presenceFingerprint({
      connectionId,
      identity,
      kind: "heartbeat",
      sequence: 0,
    });
    const next = await presenceFingerprint({
      connectionId,
      identity,
      kind: "heartbeat",
      sequence: 1,
    });
    expect(connect).not.toBe(heartbeat);
    expect(heartbeat).not.toBe(next);
  });

  test("binds the auth epoch, so a rotated epoch cannot replay presence", async () => {
    const rotated = await presenceFingerprint({
      connectionId,
      identity: { ...identity, authEpoch: 4 },
      kind: "connect",
      sequence: 0,
    });
    const original = await presenceFingerprint({
      connectionId,
      identity,
      kind: "connect",
      sequence: 0,
    });
    expect(rotated).not.toBe(original);
  });

  test("refuses a negative sequence", async () => {
    await expect(presenceFingerprint({ connectionId, identity, kind: "connect", sequence: -1 }))
      .rejects.toThrow();
  });
});

describe("presenceArgs", () => {
  test("carries the credential generation the server checks", async () => {
    const args = await presenceArgs({ connectionId, identity, kind: "connect", sequence: 0 });
    expect(args).toEqual({
      connectionId,
      credentialGeneration: 1,
      fingerprint: await presenceFingerprint({
        connectionId,
        identity,
        kind: "connect",
        sequence: 0,
      }),
      sequence: 0,
    });
  });
});

describe("sequences and identifiers", () => {
  test("a connect is sequence zero and a heartbeat is one more", () => {
    expect(nextPresenceSequence(null)).toBe(0);
    expect(nextPresenceSequence(0)).toBe(1);
    expect(nextPresenceSequence(41)).toBe(42);
  });

  test("a connection id is an opaque identifier the authority accepts", () => {
    const id = newConnectionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,96}$/u);
  });
});
